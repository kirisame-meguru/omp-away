package ru.eleven.ompaway

import android.app.Notification
import android.content.ContextWrapper
import android.content.SharedPreferences
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class InviteActionTest {
    @Test fun notificationDismissalAndNotNowBothLeaveAuthenticatedItemPending() {
        val instrument = InstrumentationRegistry.getInstrumentation()
        val target = instrument.targetContext
        val name = "away-test-${UUID.randomUUID()}"
        val isolated = object : ContextWrapper(target) {
            override fun getSharedPreferences(ignored: String, mode: Int): SharedPreferences =
                target.getSharedPreferences(name, mode)
        }
        val store = InboxStore(isolated)
        val id = UUID.randomUUID().toString()
        val item = Pending(id, "Project name must stay private", "Private question", 42)
        try {
            store.reconcile(listOf(item))
            val note = Invites.notification(target, id)
            assertNull(note.deleteIntent)
            assertNotNull(note.contentIntent)
            assertEquals("Not now", note.actions.single().title.toString())
            assertNotEquals(note.contentIntent, note.actions.single().actionIntent)
            assertNotEquals(note.actions.single().actionIntent, Invites.notification(target, "$id-2").actions.single().actionIntent)
            assertEquals("Desktop request", note.extras.getString(Notification.EXTRA_TITLE))
            assertEquals("Open your inbox to review.", note.extras.getString(Notification.EXTRA_TEXT))
            Invites.cancel(target, id)
            assertFalse(id in store.state.silenced)
            store.silence(id)
            val reopened = InboxStore(isolated)
            assertEquals(item, reopened.state.pending[id])
            assertTrue(id in reopened.state.silenced)
        } finally {
            target.deleteSharedPreferences(name)
        }
    }
}
