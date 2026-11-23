package com.example.radiance
import org.junit.Assert.*
import org.junit.Test
class QualityPolicyTest {
    @Test fun startupAndSingleStallsDoNotDowngrade() {
        val p=QualityPolicy()
        assertFalse(p.observe(3.0));assertFalse(p.observe(5.0));assertFalse(p.observe(60.0));assertFalse(p.observe(5.0))
    }
    @Test fun sustainedSlowDeviceGetsFallback() {
        val p=QualityPolicy();p.observe(4.0)
        assertFalse(p.observe(15.0));assertFalse(p.observe(15.0));assertTrue(p.observe(15.0))
        p.reset();assertFalse(p.observe(15.0))
    }
    @Test fun invalidSamplesIgnored() {
        val p=QualityPolicy();assertFalse(p.observe(Double.NaN));assertFalse(p.observe(-1.0));assertFalse(p.observe(60.0))
    }
}
