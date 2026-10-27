package art.treasuregrove.lolicode.mobile.data

interface DirectPeer {
    fun acceptOffer(negotiationId: String, sdp: String)
    fun send(frame: String): Boolean
    fun bufferedBytes(): Long = 0
    fun close()
}

interface DirectPeerEvents {
    fun answer(negotiationId: String, sdp: String)
    fun opened()
    fun frame(frame: String)
    fun failed()
}

fun interface DirectPeerFactory { fun create(events: DirectPeerEvents): DirectPeer }
