/** Turn and lifecycle counters, enough to see suspends and resumes happen. */
export interface MetricsSnapshot {
	counters: Record<string, number>;
}

export class Metrics {
	private readonly counters = new Map<string, number>();

	increment(name: string, by = 1): void {
		this.counters.set(name, (this.counters.get(name) ?? 0) + by);
	}

	snapshot(): MetricsSnapshot {
		return { counters: Object.fromEntries(this.counters) };
	}
}
