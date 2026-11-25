package ru.eleven.ompaway

import android.annotation.TargetApi
import android.content.Context
import android.graphics.RenderEffect
import android.graphics.RuntimeShader
import android.os.Build
import android.widget.FrameLayout

/** Only the underlay belongs here; the lens itself must remain a sibling. */
internal class RefractiveContent(context: Context) : FrameLayout(context) {
    private val optics = if (Build.VERSION.SDK_INT >= 33) Optics() else null
    private var lastWidth = -1
    private var lastHeight = -1
    private var lastX = Float.NaN
    private var lastY = Float.NaN
    private var lastLift = Float.NaN
    private var lastOpacity = Float.NaN
    private var lastShape = Float.NaN

    fun lens(width: Int, height: Int, x: Float, y: Float, lift: Float, opacity: Float, shape: Float) {
        val optics = optics ?: return // Android 10–12 retain the non-refractive renderer.
        if (width == lastWidth && height == lastHeight && x == lastX && y == lastY &&
            lift == lastLift && opacity == lastOpacity && shape == lastShape) return
        lastWidth = width; lastHeight = height; lastX = x; lastY = y
        lastLift = lift; lastOpacity = opacity; lastShape = shape
        if (width <= 0 || height <= 0 || x <= 0f || y <= 0f || opacity <= 0f) {
            setRenderEffect(null)
            return
        }
        // RenderEffect snapshots uniforms. Rebuild only when geometry changes, not
        // for wave animation or UI updates. The input remains the live RenderNode.
        setRenderEffect(optics.effect(width, height, x, y, lift, opacity, shape))
    }

    @TargetApi(33)
    private class Optics {
        private val shader = RuntimeShader(SOURCE)
        fun effect(width: Int, height: Int, x: Float, y: Float, lift: Float, opacity: Float, shape: Float): RenderEffect {
            shader.setFloatUniform("viewport", width.toFloat(), height.toFloat())
            shader.setFloatUniform("pose", x, y, lift, opacity)
            shader.setFloatUniform("shape", shape)
            return RenderEffect.createRuntimeShaderEffect(shader, "content")
        }
    }

    companion object {
        // A shallow glass shell compresses peripheral content rather than using
        // the prototype's solid-ball magnification and inverted exit caustic.
        private const val SOURCE = """
            uniform shader content;
            uniform float2 viewport;
            uniform float4 pose;
            uniform float shape;
            const float H = 0.744;
            half4 main(float2 position) {
                float radius = min(viewport.x, viewport.y) * 0.40;
                float2 world = (position - viewport * float2(0.5, 0.33)) / radius;
                world.y = -world.y;
                float2 p = (world - float2(0.0, pose.z)) / pose.xy;
                float pixel = 1.0 / (radius * min(pose.x, pose.y));
                half4 original = content.eval(position);
                if (abs(p.x) > 1.0 + pixel || abs(p.y) > H * (1.0 + pixel)) return original;
                float power = pow(abs(p.x), shape) + pow(abs(p.y / H), shape);
                float shell = pow(power, 1.0 / shape);
                float coverage = 1.0 - smoothstep(1.0 - pixel, 1.0 + pixel, shell);
                if (coverage <= 0.0) return original;
                float edge = smoothstep(0.50, 1.0, shell);
                float shoulder = smoothstep(0.78, 1.0, shell);
                float2 samplePoint = p * float2(1.0 + 0.30 * edge * edge * edge, 1.0 - 0.70 * shoulder);
                float2 sampleWorld = samplePoint * pose.xy + float2(0.0, pose.z);
                float2 samplePosition = viewport * float2(0.5, 0.33) + sampleWorld * float2(radius, -radius);
                samplePosition = clamp(samplePosition, float2(0.5), viewport - float2(0.5));
                return mix(original, content.eval(samplePosition), half(coverage * pose.w));
            }
        """
    }
}
