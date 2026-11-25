package com.example.radiance

import android.annotation.TargetApi
import android.content.Context
import android.graphics.RuntimeShader

/** The Canvas renderer shares its optics with Filament; only shader type spelling differs. */
@TargetApi(33)
internal class OrbOptics(context: Context) {
    val shader: RuntimeShader

    init {
        val optics = context.assets.open("lens-overlay.glsl").bufferedReader().use { it.readText() }
            .replace("vec2", "float2").replace("vec3", "float3").replace("vec4", "float4")
        shader = RuntimeShader("uniform float4 frame;\n" + optics + """
            half4 main(float2 position) {
                float4 lens = voiceLens(float2(position.x, -position.y), frame.x, frame.y, frame.z, frame.w);
                return half4(lens.rgb * lens.a, lens.a);
            }
        """)
    }

    fun update(pixel: Float, time: Float, energy: Float, shape: Float) {
        shader.setFloatUniform("frame", pixel, time, energy, shape)
    }
}
