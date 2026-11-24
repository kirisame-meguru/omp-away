package com.example.radiance

interface EnergySource {
    fun energy(seconds: Float, mode: Int): Float
}
