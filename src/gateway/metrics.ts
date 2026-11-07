/**
 * Turn-level timings and counters, kept small on purpose: the gateway only
 * needs enough history to report p50/p95 for the last few hundred turns, not
 * a general-purpose metrics store.
 */

export type TimingName = "turn_millis" | "first_token_millis" | "resume_millis";

export interface TimingSummary {
	count: number;
	p50: number;
	p95: number;
	max: number;
}

export interface MetricsSnapshot {
	counters: Record<string, number>;
	timings: Record<string, TimingSummary>;
}

const WINDOW = 200;

export class Metrics {
	private readonly counters = new Map<string, number>();
	private readonly samples = new Map<string, number[]>();

	increment(name: string, by = 1): void {
		this.counters.set(name, (this.counters.get(name) ?? 0) + by);
	}

	observe(name: TimingName, valueMs: number): void {
		if (!Number.isFinite(valueMs) || valueMs < 0) return;
		const samples = this.samples.get(name) ?? [];
		samples.push(Math.round(valueMs));
		// Keep the window bounded; older samples stop influencing p95.
		if (samples.length > WINDOW) samples.splice(0, samples.length - WINDOW);
		this.samples.set(name, samples);
	}

	snapshot(): MetricsSnapshot {
		return {
			counters: Object.fromEntries(this.counters),
			timings: Object.fromEntries(
				[...this.samples].map(([name, samples]) => [name, summarize(samples)]),
			),
		};
	}
}

function summarize(samples: number[]): TimingSummary {
	const sorted = [...samples].sort((a, b) => a - b);
	return {
		count: sorted.length,
		p50: percentile(sorted, 0.5),
		p95: percentile(sorted, 0.95),
		max: sorted.at(-1) ?? 0,
	};
}

/** Nearest-rank percentile: small windows do not need interpolation. */
function percentile(sorted: number[], fraction: number): number {
	if (sorted.length === 0) return 0;
	const rank = Math.max(1, Math.ceil(sorted.length * fraction));
	return sorted[rank - 1] ?? 0;
}
