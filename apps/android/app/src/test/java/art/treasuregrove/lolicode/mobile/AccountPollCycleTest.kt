package art.treasuregrove.lolicode.mobile

import art.treasuregrove.lolicode.mobile.data.*
import art.treasuregrove.lolicode.mobile.protocol.*
import java.io.IOException
import java.net.InetAddress
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test

class AccountPollCycleTest {
    @Test fun aTransientRecoveryGetFailureIsRetriedAfterBackoffWithoutManualRefreshOrMutations() = runBlocking {
        val fixture = AccountFixture()
        val server = MockWebServer()
        server.start(InetAddress.getByName("127.0.0.1"), 0)
        fun directory() = MockResponse().setBody(buildJsonObject { put("devices", JsonArray(listOf(fixture.deviceJson(fixture.desktop)))) }.toString())
        server.enqueue(directory())
        server.enqueue(MockResponse().setResponseCode(503).setBody("{}"))
        server.enqueue(directory())
        server.enqueue(MockResponse().setBody(buildJsonObject { put("requests", JsonArray(listOf(fixture.requestJson()))) }.toString()))
        val relay = AccountRelay(server.url("/v2/").newBuilder().host("127.0.0.1").build(), allowLocal = true)
        val session = DeviceSession(fixture.request.accountId, "fixture_device_ticket_${"a".repeat(40)}", fixture.now + 900_000, fixture.phone)
        val cycle = AccountPollCycle()
        val recoverFlags = mutableListOf<Boolean>()
        var restored: PairedComputer? = null
        suspend fun refresh(recover: Boolean) {
            recoverFlags += recover
            relay.devices(session)
            if (recover) {
                val approved = relay.requests(session).single { it.status == "approved" }
                restored = openEnrollment(approved, fixture.request.accountId, fixture.phone.deviceId, fixture.identity,
                    fixture.desktop, fixture.request.requestId, fixture.pairing.string("relayUrl"), fixture.now)
            }
        }
        try {
            try { cycle.refresh(::refresh); fail("first temporary requests GET must fail") } catch (_: IOException) { }
            assertNull(restored)
            assertEquals(30_000L, cycle.nextDelayMs(enrollmentVisible = true, pending = true))
            cycle.refresh(::refresh)
            assertEquals(listOf(true, true), recoverFlags)
            assertEquals(fixture.request.roomId, restored!!.id)
            assertTrue(restored!!.approved)
            assertEquals(3_000L, cycle.nextDelayMs(enrollmentVisible = true, pending = true))
            cycle.refresh { recover -> assertFalse(recover) }
            val requests = (1..4).map { server.takeRequest(3, TimeUnit.SECONDS) ?: error("missing recovery GET") }
            assertEquals(listOf("/v2/devices", "/v2/requests", "/v2/devices", "/v2/requests"), requests.map { it.path })
            assertTrue(requests.all { it.method == "GET" })
        } finally { server.close() }
    }
}
