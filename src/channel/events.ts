/**
 * A bounded, sequenced buffer of channel events.
 *
 * A browser can drop its socket in the middle of a stream. On reconnect it
 * says "I have seen up to sequence N"; the buffer replays everything after N
 * and then live delivery continues. Sequence numbers are assigned once, when
 * an event is recorded, so a replayed delta is byte-identical to the live one
 * and a client can de-duplicate on its own if it reconnects twice.
 */

export interface Sequenced<T> {
	seq: number;
	value: T;
}

export class EventRing<T> {
	private readonly events: Sequenced<T>[] = [];
	private next = 1;

	constructor(private readonly capacity = 512) {}

	get lastSeq(): number {
		return this.next - 1;
	}

	/** Records an event and returns it with its assigned sequence. */
	record(value: T): Sequenced<T> {
		const entry = { seq: this.next++, value };
		this.events.push(entry);
		if (this.events.length > this.capacity) this.events.splice(0, this.events.length - this.capacity);
		return entry;
	}

	/**
	 * Every retained event after `since`. A client that has fallen further
	 * behind than the buffer holds gets the whole buffer; the caller decides
	 * whether that is acceptable or should trigger a full state resync.
	 */
	since(since: number): Sequenced<T>[] {
		return this.events.filter((entry) => entry.seq > since);
	}

	/** True when `since` is older than the oldest retained sequence. */
	hasGap(since: number): boolean {
		const oldest = this.events[0];
		return since > 0 && oldest !== undefined && since < oldest.seq - 1;
	}
}
