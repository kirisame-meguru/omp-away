package com.example.radiance

import android.content.Context
import android.view.Choreographer
import android.view.Surface
import android.view.SurfaceView
import android.view.TextureView
import android.widget.FrameLayout
import com.google.android.filament.*
import com.google.android.filament.android.UiHelper
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.Locale

/** Analytic lens and three light sheets. No ray marching, blur passes, or frame allocations. */
class OrbSurface(
    context: Context,
    private val report: ((String) -> Unit)? = null,
    private val slow: () -> Unit,
    private val shell: ShellMotion,
    private val energySource: EnergySource,
    private val placement: LensPlacement = LensPlacement(),
    val layer: OrbLayer = OrbLayer.COMPOSITE,
) : FrameLayout(context), Choreographer.FrameCallback {
    companion object { init { Filament.init() } }

    private val engine = Engine.create()
    private val renderer = engine.createRenderer()
    private val scene = engine.createScene()
    private val view = engine.createView()
    private val cameraEntity = EntityManager.get().create()
    private val camera = engine.createCamera(cameraEntity)
    private val entity = EntityManager.get().create()
    private val helper = UiHelper(UiHelper.ContextErrorPolicy.DONT_CHECK)
    private val scheduler = Choreographer.getInstance()
    private val policy = QualityPolicy()
    private var swapChain: SwapChain? = null
    private val material: Material
    private val instance: MaterialInstance
    private val vertices: VertexBuffer
    private val indices: IndexBuffer
    private var resumed = false
    private var disposed = false
    private var enabled = true
    private var scheduled = false
    private var mode = 1
    private var still = true
    private var light = true
    private var automatic = true
    private var previous = 0L
    private var windowStart = 0L
    private var frames = 0
    private var elapsed = .72f

    init {
        val bytes = context.assets.open("orb.filamat").use { it.readBytes() }
        val payload = ByteBuffer.allocateDirect(bytes.size).put(bytes).apply { flip() }
        material = Material.Builder().payload(payload, payload.remaining()).build(engine)
        instance = material.createInstance()
        instance.setParameter("viewport", 1f, 1f)
        instance.setParameter("backdrop", 1f)
        instance.setParameter("layer", layer.materialValue)
        if (layer == OrbLayer.LENS) {
            // Preserve alpha in both Filament's output and the foreground texture.
            helper.isOpaque = false
            view.blendMode = com.google.android.filament.View.BlendMode.TRANSLUCENT
            renderer.clearOptions = Renderer.ClearOptions().apply { clear = true }
        }
        isClickable = false; isFocusable = false
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
        val vertexData = ByteBuffer.allocateDirect(80).order(ByteOrder.nativeOrder())
        for (value in floatArrayOf(-1f,-1f,0f,0f,0f, 1f,-1f,0f,1f,0f, -1f,1f,0f,0f,1f, 1f,1f,0f,1f,1f)) vertexData.putFloat(value)
        vertexData.flip()
        vertices = VertexBuffer.Builder().bufferCount(1).vertexCount(4)
            .attribute(VertexBuffer.VertexAttribute.POSITION, 0, VertexBuffer.AttributeType.FLOAT3, 0, 20)
            .attribute(VertexBuffer.VertexAttribute.UV0, 0, VertexBuffer.AttributeType.FLOAT2, 12, 20)
            .build(engine)
        vertices.setBufferAt(engine, 0, vertexData)
        val indexData = ByteBuffer.allocateDirect(12).order(ByteOrder.nativeOrder())
        for (index in shortArrayOf(0,1,2,2,1,3)) indexData.putShort(index)
        indexData.flip()
        indices = IndexBuffer.Builder().indexCount(6).bufferType(IndexBuffer.Builder.IndexType.USHORT).build(engine)
        indices.setBuffer(engine, indexData)
        RenderableManager.Builder(1).boundingBox(Box(0f,0f,0f,1f,1f,.01f))
            .geometry(0, RenderableManager.PrimitiveType.TRIANGLES, vertices, indices)
            .material(0, instance).castShadows(false).receiveShadows(false).build(engine, entity)
        scene.addEntity(entity)
        camera.lookAt(0.0,0.0,1.0,0.0,0.0,0.0,0.0,1.0,0.0)
        camera.setProjection(Camera.Projection.ORTHO,-1.0,1.0,-1.0,1.0,.1,10.0)
        view.scene = scene
        view.camera = camera
        view.isPostProcessingEnabled = false
        helper.renderCallback = object : UiHelper.RendererCallback {
            override fun onNativeWindowChanged(surface: Surface) {
                swapChain?.let { engine.destroySwapChain(it) }
                swapChain = engine.createSwapChain(surface, helper.swapChainFlags)
                requestFrame()
            }
            override fun onDetachedFromSurface() {
                swapChain?.let { engine.destroySwapChain(it) }
                swapChain = null
                engine.flushAndWait()
            }
            override fun onResized(width: Int, height: Int) {
                view.viewport = Viewport(0, 0, width, height)
                instance.setParameter("viewport", width.toFloat(), height.toFloat())
                placement.resize(width, height)
                requestFrame()
            }
        }
        if (layer == OrbLayer.LENS) {
            // Composite the orb with ordinary Views, not a separate on-top
            // SurfaceControl that can occlude UI outside the transparent lens.
            val texture = TextureView(context).apply { isOpaque = false }
            addView(texture, LayoutParams(-1, -1))
            helper.attachTo(texture)
        } else {
            val surface = SurfaceView(context)
            addView(surface, LayoutParams(-1, -1))
            helper.attachTo(surface)
        }
    }

    fun update(mode: Int, still: Boolean, light: Boolean, enabled: Boolean, auto: Boolean) {
        if (disposed) return
        if (this.mode == mode && this.still == still && this.light == light && this.enabled == enabled && automatic == auto) return
        if (automatic != auto || this.enabled != enabled || this.still != still) resetMeasurement()
        if (this.still && !still) elapsed = 0f
        this.mode = mode
        this.still = still
        this.light = light
        this.enabled = enabled
        automatic = auto
        instance.setParameter("backdrop", if (light) 1f else 0f)
        visibility = if (enabled) VISIBLE else INVISIBLE
        if (!enabled) {
            scheduler.removeFrameCallback(this)
            scheduled = false
        } else requestFrame()
    }

    fun refreshPlacement() { requestFrame() }

    fun resume() { resumed = true; resetMeasurement(); requestFrame() }
    fun pause() { resumed = false; scheduler.removeFrameCallback(this); scheduled = false; previous = 0L }
    private fun resetMeasurement() { policy.reset(); windowStart = 0L; frames = 0; previous = 0L }
    private fun requestFrame() {
        if (!disposed && resumed && enabled && !scheduled) { scheduled = true; scheduler.postFrameCallback(this) }
    }

    override fun doFrame(frameTimeNanos: Long) {
        scheduled = false
        if (disposed || !resumed || !enabled) return
        val dt = if (previous == 0L) 0f else ((frameTimeNanos - previous) / 1e9f).coerceIn(0f, .1f)
        previous = frameTimeNanos
        if (!still && layer != OrbLayer.SCENE) { elapsed += dt; shell.advance(dt) }
        instance.setParameter("shellPose", shell.width * placement.scale, shell.height * placement.scale,
            placement.lift(shell), shell.opacity)
        instance.setParameter("shellShape", shell.shape)
        instance.setParameter("time", elapsed)
        instance.setParameter("energy", if (layer == OrbLayer.SCENE) 0f else energySource.energy(elapsed, mode))
        val chain = swapChain
        var submitted = false
        if (chain != null && helper.isReadyToRender && renderer.beginFrame(chain, frameTimeNanos)) {
            renderer.render(view)
            renderer.endFrame()
            submitted = true
            frames++
        }
        if (submitted && (layer == OrbLayer.SCENE || still || (!shell.moving && shell.opacity == 0f))) {
            resetMeasurement()
            report?.invoke(if (still) "Still frame · native lens study" else "Retracted · native lens study")
            return
        }
        if (!still) {
            if (windowStart == 0L) windowStart = frameTimeNanos
            if (frameTimeNanos - windowStart >= 2_000_000_000L) {
                val fps = frames * 1e9 / (frameTimeNanos - windowStart)
                if (report != null) report(String.format(Locale.ROOT, "%.1f submitted fps · native lens", fps))
                frames = 0
                windowStart = frameTimeNanos
                if (automatic && policy.observe(fps)) { slow(); return }
            }
        }
        requestFrame()
    }

    fun dispose() {
        if (disposed) return
        pause()
        disposed = true
        helper.detach()
        engine.destroyEntity(entity)
        EntityManager.get().destroy(entity)
        engine.destroyVertexBuffer(vertices)
        engine.destroyIndexBuffer(indices)
        engine.destroyMaterialInstance(instance)
        engine.destroyMaterial(material)
        engine.destroyView(view)
        engine.destroyScene(scene)
        engine.destroyRenderer(renderer)
        engine.destroyCameraComponent(cameraEntity)
        EntityManager.get().destroy(cameraEntity)
        engine.destroy()
    }
}
