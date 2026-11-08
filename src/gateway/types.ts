export interface AgentRequest {
	requestId: string;
	prompt: string;
}

export interface AgentResponse {
	text: string;
	/** Set when the turn failed, so the caller gets an error instead of silence. */
	error?: string;
}

export interface AgentBackend {
	submit(request: AgentRequest): Promise<AgentResponse>;
	close?(): Promise<void>;
}
