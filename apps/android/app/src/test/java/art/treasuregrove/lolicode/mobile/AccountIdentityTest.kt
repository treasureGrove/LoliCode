package art.treasuregrove.lolicode.mobile

import art.treasuregrove.lolicode.mobile.data.*
import art.treasuregrove.lolicode.mobile.protocol.*
import java.security.KeyPairGenerator
import java.security.spec.ECGenParameterSpec
import java.net.InetAddress
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test

class AccountIdentityTest {
    @Test fun loginChecksTheSelfProfileAndNeverIncludesThePasswordInCredentials() {
        val server = MockWebServer()
        server.enqueue(MockResponse().setBody("""{"userId":42,"token":"${"a".repeat(40)}"}"""))
        server.enqueue(MockResponse().setBody("""{"data":{"type":"users","id":"42","attributes":{"username":"fixture","displayName":"Fixture","email":"fixture@example.invalid","isEmailConfirmed":true,"isAdmin":false}}}"""))
        server.start(InetAddress.getByName("127.0.0.1"), 0)
        try {
            val credential = ForumIdentity(server.url("/").newBuilder().host("127.0.0.1").build(), true).login("fixture", "transient-password")
            assertEquals("42", credential.account.id)
            assertFalse(credential.toString().contains("a".repeat(40)))
            assertFalse(credential.toJson().toString().contains("transient-password"))
            assertEquals("/api/token", server.takeRequest().path)
            val profile = server.takeRequest()
            assertEquals("/api/users/42", profile.path)
            assertEquals("Token ${"a".repeat(40)}", profile.getHeader("Authorization"))
        } finally { server.close() }
    }

    @Test fun aPublicProfileWithHttp200DoesNotAuthenticateAnInvalidToken() {
        val server = MockWebServer()
        server.enqueue(MockResponse().setBody("""{"userId":"42","token":"${"a".repeat(40)}"}"""))
        server.enqueue(MockResponse().setBody("""{"data":{"type":"users","id":"42","attributes":{"username":"public"}}}"""))
        server.start(InetAddress.getByName("127.0.0.1"), 0)
        try { assertThrows(IllegalArgumentException::class.java) { ForumIdentity(server.url("/").newBuilder().host("127.0.0.1").build(), true).login("fixture", "password") } }
        finally { server.close() }
    }

    @Test fun malformedJsonNeverEchoesSensitiveResponseTextInItsError() {
        val server = MockWebServer()
        val sentinel = "fictional-token-that-must-not-appear-in-errors"
        server.enqueue(MockResponse().setBody("""{"token":"$sentinel","broken": }"""))
        server.start(InetAddress.getByName("127.0.0.1"), 0)
        try {
            val failure = assertThrows(IllegalArgumentException::class.java) {
                ForumIdentity(server.url("/").newBuilder().host("127.0.0.1").build(), true).login("fixture", "fictional-password")
            }
            assertEquals("账号响应格式无效", failure.message)
            assertFalse(failure.toString().contains(sentinel))
            assertNull(failure.cause)
        } finally { server.close() }
    }

    @Test fun theIdentityKeyIsIndependentAndRestoresWithoutRotation() {
        val first = DeviceIdentity.generate()
        val second = DeviceIdentity.generate()
        assertArrayEquals(first.sharedSecret(second.publicKeySpki), second.sharedSecret(first.publicKeySpki))
        val restored = DeviceIdentity.restore(first.privatePkcs8(), first.publicKeySpki)
        assertEquals(first.fingerprint, restored.fingerprint)
        assertEquals(first.publicKeySpki, restored.publicKeySpki)
        assertFalse(restored.toString().contains(first.privatePkcs8()))
        assertThrows(IllegalArgumentException::class.java) { DeviceIdentity.restore(second.privatePkcs8(), first.publicKeySpki) }
        val wrongCurve = KeyPairGenerator.getInstance("EC").run { initialize(ECGenParameterSpec("secp384r1")); generateKeyPair() }
        assertThrows(IllegalArgumentException::class.java) { DeviceIdentity.parsePublic(encodeBase64(wrongCurve.public.encoded)) }
    }

    @Test fun hkdfMatchesTheFirstBlockOfRfc5869TestCaseOne() {
        val ikm = ByteArray(22) { 0x0b }
        val salt = ByteArray(13) { it.toByte() }
        val info = ByteArray(10) { (0xf0 + it).toByte() }
        val result = hkdfSha256(ikm, salt, info).joinToString("") { "%02x".format(it) }
        assertEquals("3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf", result)
    }
}
