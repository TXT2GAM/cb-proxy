/**
 * CodeBuddy API 代理服务器 - Deno 版本
 * 适用于 Deno Deploy 等云端平台部署
 */

// 模型映射配置
const modelMapping: Record<string, string> = {
  "claude-4.0": "default-model"
};

/**
 * 处理聊天完成请求的核心函数
 * 根据请求路径判断 API 格式并进行相应转换
 */
const handleRequest = async (request: Request): Promise<Response> => {
  try {
    // 只处理 POST 请求且路径包含 /chat/completions
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const url = new URL(request.url);
    if (!url.pathname.includes('/chat/completions')) {
      return new Response('Not Found', { status: 404 });
    }

    const body = await request.json();
    const isStream = body.stream === true;
    const token = request.headers.get('authorization') ||
                  request.headers.get('x-api-key') ||
                  request.headers.get('Authorization');

    if (!token) {
      return new Response(JSON.stringify({
        error: {
          message: 'Authorization header is required',
          type: 'auth_error'
        },
        type: 'error'
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const messages = handleChatMessage(body.messages);

    // 应用模型映射
    const originalModel = body.model;
    const mappedModel = modelMapping[body.model] || body.model;

    // 向 CodeBuddy API 发送请求
    const response = await fetch('https://www.codebuddy.ai/v2/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': token,
        'Content-Type': 'application/json',
        'User-Agent': 'CodeBuddyIDE/0.2.2',
        'Connection': 'close',
      },
      body: JSON.stringify({ ...body, stream: true, messages, model: mappedModel })
    });

    if (!response.ok) {
      const errorData = await response.text();
      console.error(`CodeBuddy API Error: Status ${response.status}, Response: ${errorData}`);
      let errorMessage;
      try {
        const parsed = JSON.parse(errorData);
        errorMessage = parsed.error?.message || parsed.message || 'API request failed';
      } catch {
        errorMessage = 'API request failed';
      }

      return new Response(JSON.stringify({
        error: {
          message: errorMessage,
          type: 'server_error'
        },
        type: 'error'
      }), {
        status: response.status,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 处理响应
    if (isStream) {
      // 直接透传流数据
      return new Response(response.body, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key',
        }
      });
    } else {
      // 收集流数据转为非流格式
      const result = await collectStreamData(response.body!);
      return new Response(JSON.stringify(result), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key',
        }
      });
    }

  } catch (error) {
    console.error('Request handling error:', error);
    return new Response(JSON.stringify({
      error: {
        message: error instanceof Error ? error.message : 'Internal Server Error',
        type: 'server_error'
      },
      type: 'error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

// 搜集流数据转为openai非流标准格式
const collectStreamData = async (stream: ReadableStream<Uint8Array>) => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();

  let content = '';
  let model = '';
  let id = '';
  let created = Math.floor(Date.now() / 1000);
  let finishReason = 'stop';
  let toolCalls: any[] = [];
  let usage = {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();

          if (data === '[DONE]') {
            continue;
          }

          try {
            const parsed = JSON.parse(data);

            if (parsed.id) id = parsed.id;
            if (parsed.model) model = parsed.model;
            if (parsed.created) created = parsed.created;
            if (parsed.usage) {
              usage = parsed.usage;
            }

            if (parsed.choices && parsed.choices[0]) {
              const choice = parsed.choices[0];

              // 处理内容
              if (choice.delta && choice.delta.content) {
                content += choice.delta.content;
              }

              // 处理工具调用
              if (choice.delta && choice.delta.tool_calls && choice.delta.tool_calls.length > 0) {
                for (const toolCall of choice.delta.tool_calls) {
                  const toolIndex = toolCall.index || 0;

                  if (toolCall.id && toolCall.type && toolCall.function) {
                    // 新的工具调用
                    const currentToolCall = {
                      id: toolCall.id,
                      type: toolCall.type,
                      function: {
                        name: toolCall.function.name || '',
                        arguments: toolCall.function.arguments || ''
                      }
                    };
                    toolCalls[toolIndex] = currentToolCall;
                  } else if (toolCalls[toolIndex] && toolCall.function) {
                    // 继续追加参数
                    if (toolCall.function.arguments !== undefined) {
                      toolCalls[toolIndex].function.arguments += toolCall.function.arguments;
                    }
                    if (toolCall.function.name) {
                      toolCalls[toolIndex].function.name = toolCall.function.name;
                    }
                  }
                }
              }

              if (choice.finish_reason) {
                finishReason = choice.finish_reason;
              }
            }
          } catch (e) {
            // 忽略解析错误
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  const message: any = {
    role: 'assistant',
    content: content || null
  };

  // 如果有工具调用，添加到消息中
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }

  return {
    id: id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: created,
    model: model || 'gpt-3.5-turbo',
    choices: [{
      index: 0,
      message: message,
      finish_reason: finishReason
    }],
    usage: usage
  };
};

// 处理聊天消息格式
const handleChatMessage = (messages: any[]) => {
  // 先过滤和修复所有消息
  const fixedMessages = [];

  for (const message of messages) {
    // 跳过完全空的消息
    if (!message || (!message.content && !message.role)) {
      continue;
    }

    const fixedMessage = { ...message };

    if (message.content && typeof message.content === 'string') {
      // 确保文本内容非空
      const textContent = message.content.trim();
      if (textContent) {
        fixedMessage.content = [{
          type: 'text',
          text: textContent
        }];
      } else {
        continue;
      }
    } else if (Array.isArray(message.content)) {
      // 确保text字段非空
      const validContent = message.content.filter(item =>
        item && item.type === 'text' && item.text && item.text.trim()
      ).map(item => ({
        ...item,
        text: item.text.trim()
      }));

      // 如果过滤后没有有效内容，跳过这个消息
      if (validContent.length === 0) {
        continue;
      }
      fixedMessage.content = validContent;
    } else if (!message.content) {
      continue;
    }

    fixedMessages.push(fixedMessage);
  }

  // 如果只有一个消息且不是system消息，添加system消息
  if (fixedMessages.length === 1 && fixedMessages[0].role !== 'system') {
    return [
      {
        role: 'system',
        content: [
          {
            type: 'text',
            text: "You are a helpful assistant."
          }
        ]
      },
      ...fixedMessages
    ];
  }

  return fixedMessages;
};

// 模型列表
const models = [
  {
    id: "claude-4.0",
    object: "model",
    created: 1677610602,
    owned_by: "anthropic"
  },
  {
    id: "gemini-2.5-pro",
    object: "model",
    created: 1677610602,
    owned_by: "google"
  },
  {
    id: "gemini-2.5-flash",
    object: "model",
    created: 1677610602,
    owned_by: "google"
  },
  {
    id: "gpt-5",
    object: "model",
    created: 1677610602,
    owned_by: "openai"
  },
  {
    id: "gpt-5-nano",
    object: "model",
    created: 1677610602,
    owned_by: "openai"
  },
  {
    id: "gpt-5-mini",
    object: "model",
    created: 1677610602,
    owned_by: "openai"
  },
  {
    id: "o4-mini",
    object: "model",
    created: 1677610602,
    owned_by: "openai"
  }
];

// 处理模型列表请求
const handleModelsRequest = (): Response => {
  return new Response(JSON.stringify({
    object: "list",
    data: models
  }), {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key',
    }
  });
};

// 处理 CORS 预检请求
const handleCORS = (request: Request): Response => {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key',
        'Access-Control-Max-Age': '86400',
      }
    });
  }

  return new Response('Method Not Allowed', { status: 405 });
};

// 主服务器处理函数
const handler = async (request: Request): Promise<Response> => {
  // 处理 CORS 预检请求
  if (request.method === 'OPTIONS') {
    return handleCORS(request);
  }

  const url = new URL(request.url);

  // 处理模型列表请求
  if (url.pathname.includes('/models') && request.method === 'GET') {
    return handleModelsRequest();
  }

  // 处理聊天完成请求
  return handleRequest(request);
};

// 启动服务器
const port = parseInt(Deno.env.get('PORT') || '8000');

console.log(`CodeBuddy API 代理服务器已启动，监听端口 ${port}`);

// 对于 Deno Deploy，直接导出 handler
// 对于本地开发，启动 HTTP 服务器
if (import.meta.main) {
  Deno.serve({ port }, handler);
}

export default handler;