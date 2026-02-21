import dotenv from "dotenv";
import { Model } from '../types/models';
import Together from 'together-ai';
import * as prompts from './prompts';
import { parseJson } from './parse_utils';
import { CODEX_API_ENDPOINT, ensureOpenAIAuth } from './openaiOAuth';
import { v4 as uuidv4 } from 'uuid';

dotenv.config({ path: "./config.env" });


type Message = Together.Chat.Completions.CompletionCreateParams.Message | OpenAI.Chat.ChatCompletionMessageParam;

function messageText(message: Message): string {
    const content = message.content;
    if (typeof content === 'string') {
        return content;
    }
    if (Array.isArray(content)) {
        const parts = content
            .map((part) => {
                if (typeof (part as { text?: string }).text === 'string') {
                    return (part as { text: string }).text;
                }
                return '';
            })
            .filter(Boolean);
        if (parts.length > 0) {
            return parts.join('');
        }
    }
    return JSON.stringify(content);
}

function buildResponseInput(messages: Message[], isJson: boolean) {
    const instructions: string[] = ['You are a helpful assistant.'];
    const items = messages
        .map((message) => {
            const text = messageText(message).trim();
            if (!text) {
                return undefined;
            }
            if (message.role === 'system' || message.role === 'developer') {
                instructions.push(text);
                return undefined;
            }
            if (message.role === 'assistant') {
                return {
                    type: 'message' as const,
                    role: 'user' as const,
                    content: [{ type: 'input_text' as const, text: `assistant: ${text}` }],
                };
            }
            return {
                type: 'message' as const,
                role: 'user' as const,
                content: [{ type: 'input_text' as const, text }],
            };
        })
        .filter(Boolean);

    if (isJson) {
        instructions.push('Return valid JSON only.');
    }

    return { input: items, instructions: instructions.join('\n\n') };
}

async function callCodex(model: string, payload: ReturnType<typeof buildResponseInput>, auth: { access: string; accountId?: string }) {
    const response = await fetch(CODEX_API_ENDPOINT, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            authorization: `Bearer ${auth.access}`,
            originator: 'opencode',
            'User-Agent': 'stackfish/0.1.0',
            session_id: uuidv4(),
            ...(auth.accountId ? { 'ChatGPT-Account-Id': auth.accountId } : {}),
        },
        body: JSON.stringify({
            model,
            input: payload.input,
            instructions: payload.instructions,
            store: false,
            stream: true,
        }),
    });

    if (!response.ok) {
        const text = await response.text();
        const message = text ? `${response.status} ${text}` : `${response.status}`;
        const error = new Error(message);
        (error as Error & { status?: number }).status = response.status;
        throw error;
    }

    if (!response.body) {
        return '';
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let output = '';

    while (true) {
        const { value, done } = await reader.read();
        if (done) {
            break;
        }
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';

        for (const part of parts) {
            const lines = part.split('\n');
            const dataLines = lines.filter((line) => line.startsWith('data:'));
            if (dataLines.length === 0) {
                continue;
            }
            const data = dataLines.map((line) => line.slice(5).trim()).join('\n');
            if (!data || data === '[DONE]') {
                continue;
            }
            try {
                const event = JSON.parse(data);
                if (event?.type === 'response.output_text.delta' && typeof event.delta === 'string') {
                    output += event.delta;
                }
                if (!output && event?.type === 'response.output_text.done' && typeof event.text === 'string') {
                    output = event.text;
                }
                if (!output && event?.response?.output_text) {
                    output = event.response.output_text;
                }
            } catch {
                continue;
            }
        }
    }

    return output;
}

async function llm(messages: string | Message[], model: Model, isJson: boolean = false): Promise<string> {
    // Convert string input to proper message format
    const formattedMessages = typeof messages === 'string' 
        ? [{ role: "user", content: messages }] as Message[]
        : messages;

    try {
        if (model === 'qwq-32b-preview') {
            const client = new Together({apiKey: process.env.TOGETHER_API_KEY});
            const response = await client.chat.completions.create({
                model: 'Qwen/QwQ-32B-Preview',
                messages: formattedMessages as Together.Chat.Completions.CompletionCreateParams.Message[],
                max_tokens: 8192,
            });
            const answer = response.choices[0].message?.content || '';
            formattedMessages.push({ role: "assistant", content: answer });
            formattedMessages.push({ role: "user", content: prompts.final_answer_prompt() });
            return llm(formattedMessages, 'llama-3.3-70b', isJson);
        } else if (model === 'llama-3.3-70b') {
            const client = new Together({apiKey: process.env.TOGETHER_API_KEY});
            const response = await client.chat.completions.create({
                model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
                messages: formattedMessages as Together.Chat.Completions.CompletionCreateParams.Message[],
                response_format: isJson ? { type: "json_object" } : undefined,
                max_tokens: 8192,
            });
            const content = response.choices[0].message?.content || '';
            // Unfortunately, JSON mode is not yet supported by Together for this model
            // so have to add manual parsing
            if (isJson) {
                return JSON.stringify(parseJson(content));
            }
            return content;
        } else {
            const auth = await ensureOpenAIAuth();
            if (!auth) {
                throw new Error('OpenAI OAuth is not connected. Connect ChatGPT subscription to use Codex models.');
            }
            const payload = buildResponseInput(formattedMessages as Message[], isJson);
            const fallbackModels = Array.from(new Set([
                model,
                'gpt-5.3-codex',
                'gpt-5.2-codex',
                'gpt-5.1-codex',
                'gpt-5.1-codex-mini',
                'gpt-5.1-codex-max',
            ]));

            let lastError: Error | undefined;
            for (const candidate of fallbackModels) {
                for (let attempt = 0; attempt < 3; attempt += 1) {
                    try {
                        return await callCodex(candidate, payload, auth);
                    } catch (error) {
                        const err = error as Error & { status?: number };
                        lastError = err;
                        if (err.status && err.status !== 400 && err.status !== 429 && err.status !== 500 && err.status !== 503) {
                            throw err;
                        }
                        if (err.status === 400) {
                            break;
                        }
                    }
                }
            }

            throw lastError || new Error('Codex request failed');
        }
    } catch (error) {
        console.error("Error in LLM call:", error);
        throw error;
    }
}

export default llm; 
