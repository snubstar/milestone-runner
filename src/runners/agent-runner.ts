export interface AgentRunRequest {
  phase: string;
  prompt: string;
  artifacts?: Record<string, string>;
  cwd?: string;
  milestoneId?: number;
  outputSchemaPath?: string;
}

export interface AgentRunResult {
  text: string;
  exitCode: number;
  metadata?: Record<string, unknown>;
}

export interface AgentRunner {
  readonly type: string;
  run(request: AgentRunRequest): Promise<AgentRunResult>;
}
