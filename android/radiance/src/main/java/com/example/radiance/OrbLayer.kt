package com.example.radiance

/** Matches orb.mat's layer parameter; the prototype keeps the original composite scene. */
enum class OrbLayer(val materialValue: Float) {
    COMPOSITE(0f), SCENE(1f), LENS(2f),
}
