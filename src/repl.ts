import readline from 'node:readline';
import process from 'node:process';

export type AskOptions = {
  provider?: string;
  agent?: string;
  model?: string;
  system?: string;
  instructions?: string[];
  cwd?: string;
  environment?: Record<string, string>;
};

export type AskCommand = {
  prompt: string;
  options: AskOptions;
};

export type AskRequest = AskCommand;

interface AgentProvider {
  ask(request: AskRequest): AsyncIterable<string>;
}

class OpenAIAgentProvider implements AgentProvider {
  private readonly apiKey?: string;

  constructor() {
    this.apiKey = process.env.OPENAI_API_KEY;
    if (!this.apiKey) {
      throw new Error('OPENAI_API_KEY environment variable is required for the openai provider');
    }
  }

  async *ask({ prompt, options }: AskRequest): AsyncIterable<string> {
    const { Agent, run } = (await import('@openai/agents')) as any;

    if (options.environment?.OPENAI_COMPATABLE_API) {
      process.env.OPENAI_BASE_URL = options.environment.OPENAI_COMPATABLE_API;
    }

    const agent = new Agent({
      name: options.agent || 'pantheon-repl',
      instructions: options.system || 'Respond concisely in markdown.',
      model: options.model,
    });

    await registerWorkspace(options.cwd || process.cwd(), 'openai');

    const result: any = await run(agent, prompt, {
      stream: true,
    });

    const textStream: AsyncIterable<any> =
      typeof result?.toTextStream === 'function'
        ? result.toTextStream({ compatibleWithNodeStreams: false })
        : (result as AsyncIterable<any>);

    for await (const chunk of textStream) {
      const text = typeof chunk === 'string' ? chunk : chunk.toString();
      yield text;
    }

    if (result?.completed) {
      await result.completed;
    }
  }
}

class OpenCodeProvider implements AgentProvider {
  async *ask({ prompt, options }: AskRequest): AsyncIterable<string> {
    try {
      const moduleName = '@opencode-ai/sdk';
      // Using indirection to avoid type resolution errors when the SDK is not installed yet
      await import(moduleName).catch((err) => {
        throw err;
      });

      const { createOpencodeClient } = (await import('@opencode-ai/sdk/client')) as any;
      if (typeof createOpencodeClient !== 'function') {
        throw new Error('Loaded @opencode-ai/sdk but could not find createOpencodeClient');
      }

      // Prefer default global opencode daemon; fall back to localhost:4096. API key only for CI/custom hosts.
      const baseUrl = process.env.OPENCODE_BASE_URL || 'http://localhost:4096';
      const client = createOpencodeClient({ apiKey: process.env.OPENCODE_API_KEY, baseUrl });

      await registerWorkspace(options.cwd || process.cwd(), 'opencode');

      // Minimal request: create session then prompt with a text part
      const session = await client.session.create();
      const sessionId =
        (session as any)?.id || (session as any)?.data?.id || (session as any)?.session?.id;
      if (!sessionId) {
        throw new Error('OpenCode session.create() did not return an id');
      }

      const promptResult = await client.session.prompt({
        path: { id: sessionId },
        body: {
          agent: options.agent,
          parts: [{ type: 'text', text: prompt }],
        },
      });

      const parts: any[] =
        (promptResult as any)?.parts ||
        (promptResult as any)?.data?.parts ||
        (promptResult as any)?.assistantMessage?.parts ||
        [];

      if (parts.length === 0) {
        const fallbackContent =
          (promptResult as any)?.assistantMessage?.content ||
          (promptResult as any)?.data?.content ||
          (promptResult as any)?.content ||
          JSON.stringify(promptResult);
        yield typeof fallbackContent === 'string' ? fallbackContent : String(fallbackContent ?? '');
        return;
      }

      for (const part of parts) {
        const text = part?.text || part?.content || part?.delta;
        if (text) {
          yield typeof text === 'string' ? text : String(text);
        }
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown error while using opencode provider';
      throw new Error(
        `OpenCode provider unavailable: ${message}. Ensure @opencode-ai/sdk is installed (API key only needed for CI/custom hosts).`,
      );
    }
  }
}

function parseAskExpression(input: string): AskCommand {
  const trimmed = input.trim();
  if (!trimmed.startsWith('(') || !trimmed.endsWith(')')) {
    throw new Error('Input must be an s-expression, e.g. (ask "question")');
  }

  const body = trimmed.slice(1, -1).trim();
  if (!body.toLowerCase().startsWith('ask')) {
    throw new Error('Only (ask ...) expressions are supported');
  }

  const options: AskOptions = {};

  const queryMatch = body.match(/:query\s+"([^"]+)"/i);
  const promptText = queryMatch?.[1] ?? body.match(/"([^"]+)"/)?.[1] ?? '';
  if (!promptText) {
    throw new Error('Missing question string in ask expression');
  }

  const providerMatch =
    body.match(/:harness\s+'([a-zA-Z0-9_./-]+)/i) || body.match(/:provider\s+'([a-zA-Z0-9_./-]+)/i);
  if (providerMatch?.[1]) {
    options.provider = providerMatch[1].toLowerCase();
  }

  const agentMatch =
    body.match(/:role\s+'([a-zA-Z0-9_./-]+)/i) || body.match(/:agent\s+'([a-zA-Z0-9_./-]+)/i);
  if (agentMatch?.[1]) {
    options.agent = agentMatch[1];
  }

  const modelMatch = body.match(/:model\s+'([a-zA-Z0-9_./-]+)/i);
  if (modelMatch?.[1]) {
    options.model = modelMatch[1];
  }

  const systemMatch = body.match(/:system\s+"([^"]+)"/i);
  if (systemMatch?.[1]) {
    options.system = systemMatch[1];
  }

  const instructionsMatch = body.match(/:instructions\s+\[(.*?)\]/i);
  if (instructionsMatch?.[1]) {
    options.instructions = instructionsMatch[1]
      .split(/\s+/)
      .map((s) => s.replace(/^["']|["']$/g, ''))
      .filter(Boolean);
  }

  const cwdMatch = body.match(/:cwd\s+"([^"]+)"/i);
  if (cwdMatch?.[1]) {
    options.cwd = cwdMatch[1];
  }

  const envMatch = body.match(/:OPENAI_COMPATABLE_API\s+"([^"]+)"/i);
  if (envMatch?.[1]) {
    options.environment = { OPENAI_COMPATABLE_API: envMatch[1] };
  }

  return {
    prompt: promptText,
    options,
  };
}

const REGISTRY_URL = process.env.PANTHEON_REGISTRY_URL || 'http://127.0.0.1:4097';

async function registerWorkspace(path: string, provider: string): Promise<void> {
  try {
    await fetch(`${REGISTRY_URL}/workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, providers: [provider] }),
    });
  } catch {
    // best-effort; ignore failures for local dev
  }
}

async function listWorkspaces(): Promise<string> {
  const res = await fetch(`${REGISTRY_URL}/workspaces`).catch((err) => {
    throw new Error(`Workspace registry not reachable at ${REGISTRY_URL}: ${err}`);
  });
  if (!res.ok) {
    throw new Error(`Workspace registry error ${res.status}`);
  }
  const json = (await res.json()) as { data?: any[] };
  const entries = json.data ?? [];
  if (entries.length === 0) return 'No workspaces registered';
  return entries
    .map((w) => `- ${w.path} [providers: ${(w.providers ?? []).join(', ') || 'none'}]`)
    .join('\n');
}

function createProvider(name: string): AgentProvider {
  switch (name.toLowerCase()) {
    case 'openai':
      return new OpenAIAgentProvider();
    case 'opencode':
      return new OpenCodeProvider();
    default:
      throw new Error(`Unknown provider "${name}". Use :provider 'openai or :provider 'opencode.`);
  }
}

export async function startRepl(): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'pantheon> ',
  });

  console.log('Pantheon Lisp REPL — use (ask "question" :provider "openai") or :quit to exit');
  rl.prompt();

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) {
      rl.prompt();
      continue;
    }
    if (trimmed === ':quit' || trimmed === ':exit') {
      break;
    }

    try {
      if (trimmed.startsWith('(workspaces')) {
        const output = await listWorkspaces();
        console.log(output);
        rl.prompt();
        continue;
      }

      const command = parseAskExpression(trimmed);
      const providerName = command.options.provider || 'openai';
      const provider = createProvider(providerName);

      for await (const chunk of provider.ask(command)) {
        process.stdout.write(chunk);
      }

      process.stdout.write('\n');
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
    }

    rl.prompt();
  }

  rl.close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startRepl().catch((error) => {
    console.error('REPL failed:', error);
    process.exit(1);
  });
}
