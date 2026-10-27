package art.treasuregrove.lolicode.mobile

import art.treasuregrove.lolicode.mobile.data.*
import art.treasuregrove.lolicode.mobile.protocol.*
import org.junit.Assert.*
import org.junit.Test

class DevicePresenceTest {
    private val key = DeviceIdentity.generate()
    private val desktop = AccountDevice("00000000-0000-4000-8000-000000000010", "Fixture", "desktop", key.publicKeySpki, key.fingerprint, true, Long.MAX_VALUE)
    private val pairing = Pairing("wss://lolicode.com/companion/ws", "a".repeat(32), "b".repeat(64), encodeBase64(ByteArray(32)), "Fixture", 0)
    private val computer = PairedComputer(pairing, "phone", true, "42", desktop.deviceId, desktop.fingerprint)
    private fun state() = CompanionState(account = AccountProfile("42", "fixture", "Fixture"),
        computers = listOf(computer), selectedRoom = computer.id, discoveredComputers = listOf(desktop),
        directoryFreshness = DirectoryFreshness("42", 1_000, true), presenceNowElapsedMs = 1_000)

    @Test fun freshnessUsesOnlyBoundedMonotonicTimeAndTheActiveAccount() {
        val fresh = DirectoryFreshness("42", 1_000, true)
        assertTrue(fresh.isFreshFor("42", 1_000))
        assertTrue(fresh.isFreshFor("42", 60_999))
        assertFalse(fresh.isFreshFor("42", 61_000))
        assertFalse(fresh.isFreshFor("42", 999))
        assertFalse(fresh.isFreshFor(null, 1_000))
        assertFalse(fresh.isFreshFor("43", 1_000))
        assertFalse(fresh.copy(valid = false).isFreshFor("42", 1_000))
        assertFalse(fresh.copy(fetchedAtElapsedMs = -1).isFreshFor("42", 1_000))
    }

    @Test fun canonicalFreshDirectoryDeterminesOnlineEvenWhenAnOldRowIsRetained() {
        val current = state().copy(discoveredComputers = listOf(desktop.copy(online = false, lastSeenAt = 0)))
        assertEquals(DevicePresence.Offline, current.presence(desktop))
        assertEquals(DevicePresence.Offline, current.selectedPresence)
        // Server wall clocks do not extend or shorten a local successful fetch.
        assertEquals(DevicePresence.Online, state().selectedPresence)
        assertEquals(DevicePresence.Unknown, state().copy(presenceNowElapsedMs = 61_000).selectedPresence)
    }

    @Test fun cacheFailureAndForegroundRevalidationKeepTheListButShowUnknown() {
        val cached = state()
        val unknown = cached.copy(directoryFreshness = cached.directoryFreshness.copy(valid = false), presenceNowElapsedMs = 500_000)
        assertEquals(cached.discoveredComputers, unknown.discoveredComputers)
        assertEquals(DevicePresence.Unknown, unknown.selectedPresence)
        assertEquals(DevicePresence.Unknown, unknown.presence(desktop))
        val refreshed = unknown.copy(directoryFreshness = DirectoryFreshness("42", 500_001, true), presenceNowElapsedMs = 500_001)
        assertEquals(DevicePresence.Online, refreshed.selectedPresence)
    }

    @Test fun directoryRowsAndSavedRoomsCannotCrossAccountOrPeerIdentity() {
        assertEquals(DevicePresence.Unknown, state().copy(account = AccountProfile("43", "other", "Other")).selectedPresence)
        assertEquals(DevicePresence.Unknown, state().presence(computer.copy(accountId = "43")))
        assertEquals(DevicePresence.Unknown, state().presence(computer.copy(desktopDeviceId = "00000000-0000-4000-8000-000000000099")))
        assertEquals(DevicePresence.Unknown, state().presence(computer.copy(desktopFingerprint = "0".repeat(64))))
        assertEquals(DevicePresence.Unknown, state().presence(desktop.copy(publicKey = DeviceIdentity.generate().publicKeySpki)))
        assertEquals(DevicePresence.Unknown, state().copy(discoveredComputers = emptyList()).selectedPresence)
    }

    @Test fun switchingTheSelectedComputerDoesNotReuseThePreviousGreenStatus() {
        val secondDevice = desktop.copy(deviceId = "00000000-0000-4000-8000-000000000011", online = false)
        val second = computer.copy(pairing = pairing.copy(roomId = "c".repeat(32)), desktopDeviceId = secondDevice.deviceId)
        val two = state().copy(computers = listOf(computer, second), discoveredComputers = listOf(desktop, secondDevice))
        assertEquals(DevicePresence.Online, two.selectedPresence)
        assertEquals(DevicePresence.Offline, two.copy(selectedRoom = second.id).selectedPresence)
    }

    @Test fun heartbeatPresenceNeverGrantsTaskPermissionAndUnknownDoesNotBreakARealDirectRoute() {
        val current = state().copy(relayReady = true, desktopOnline = true, hostVerified = true)
        assertEquals(DevicePresence.Online, current.selectedPresence)
        assertFalse(current.usable)
        val direct = current.copy(transport = "direct")
        assertTrue(direct.usable)
        assertFalse(direct.copy(hostVerified = false).usable)
        assertFalse(direct.copy(desktopOnline = false).usable)
        assertFalse(direct.copy(computers = listOf(computer.copy(approved = false))).usable)
        assertTrue(direct.copy(directoryFreshness = DirectoryFreshness()).usable)
    }

    @Test fun losingTheRoomPeerClosesTaskAccessWithoutInventingDirectoryOffline() {
        val disconnected = state().copy(transport = null, relayReady = false, desktopOnline = false, hostVerified = false)
        assertEquals(DevicePresence.Online, disconnected.selectedPresence)
        assertFalse(disconnected.usable)
        assertEquals(DevicePresence.Unknown, disconnected.copy(presenceNowElapsedMs = 61_000).selectedPresence)
    }

    @Test fun textTransportRequiresSeparateHostApprovalAndVerification() {
        val text = state().copy(transport = "text", relayReady = true, desktopOnline = true, hostVerified = true)
        assertTrue(text.usable)
        assertFalse(text.copy(hostVerified = false).usable)
        assertFalse(text.copy(relayReady = false).usable)
        assertFalse(text.copy(desktopOnline = false).usable)
        assertFalse(text.copy(computers = listOf(computer.copy(approved = false))).usable)
        assertFalse(text.copy(transport = "ws").usable)
    }
}
