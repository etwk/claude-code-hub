/**
 * 消息内容提取器
 *
 * 从 Request API 格式的消息中提取需要检测的文本内容
 * 支持：
 * - system 字段（string 或 array）
 * - messages 字段中 role='user' 的消息内容
 * - input 字段（Response API 格式）
 */

interface MessageBlock {
  type?: string;
  text?: string;
  content?: string;
}

interface Message {
  role?: string;
  content?: string | MessageBlock[];
}

/**
 * 从单个消息块中提取文本
 */
function extractTextFromBlock(block: unknown): string | null {
  if (typeof block === "string") {
    return block;
  }

  if (typeof block === "object" && block !== null) {
    const obj = block as Record<string, unknown>;

    // 优先提取 text 字段
    if (typeof obj.text === "string") {
      return obj.text;
    }

    // 兼容 content 字段
    if (typeof obj.content === "string") {
      return obj.content;
    }
  }

  return null;
}

/**
 * 从 system 字段中提取文本
 */
function extractSystemText(system: unknown): string[] {
  const texts: string[] = [];

  if (typeof system === "string") {
    texts.push(system);
  } else if (Array.isArray(system)) {
    system.forEach((item) => {
      const text = extractTextFromBlock(item);
      if (text) {
        texts.push(text);
      }
    });
  }

  return texts;
}

/**
 * 从 messages 数组中提取用户消息文本
 */
function extractMessagesText(messages: unknown): string[] {
  const texts: string[] = [];

  if (!Array.isArray(messages)) {
    return texts;
  }

  messages.forEach((msg) => {
    if (typeof msg !== "object" || msg === null) {
      return;
    }

    const message = msg as Message;

    // 仅提取用户消息
    if (message.role !== "user") {
      return;
    }

    // 处理 content 字段
    if (typeof message.content === "string") {
      texts.push(message.content);
    } else if (Array.isArray(message.content)) {
      message.content.forEach((block) => {
        const text = extractTextFromBlock(block);
        if (text) {
          texts.push(text);
        }
      });
    }
  });

  return texts;
}

/**
 * 从 input 字段中提取文本（Response API 格式）
 */
function extractInputText(input: unknown): string[] {
  const texts: string[] = [];

  if (!Array.isArray(input)) {
    return texts;
  }

  input.forEach((item) => {
    if (typeof item !== "object" || item === null) {
      return;
    }

    const obj = item as Record<string, unknown>;

    // 处理 role='user' 的消息
    if (obj.role !== "user") {
      return;
    }

    // 提取 content
    if (typeof obj.content === "string") {
      texts.push(obj.content);
    } else if (Array.isArray(obj.content)) {
      obj.content.forEach((block) => {
        const text = extractTextFromBlock(block);
        if (text) {
          texts.push(text);
        }
      });
    }
  });

  return texts;
}

/**
 * 从请求消息中提取所有需要检测的文本
 *
 * @param message - Request API 或 Response API 格式的消息对象
 * @returns 需要检测的文本数组
 */
export function extractTextFromMessages(message: Record<string, unknown>): string[] {
  const texts: string[] = [];

  // 0. 提取图片接口等顶层 prompt 文本
  if (typeof message.prompt === "string") {
    texts.push(message.prompt);
  } else if (Array.isArray(message.prompt)) {
    for (const item of message.prompt) {
      if (typeof item === "string") {
        texts.push(item);
      }
    }
  }

  // 1. 提取 system
  if ("system" in message) {
    const systemTexts = extractSystemText(message.system);
    texts.push(...systemTexts);
  }

  // 2. 提取 messages（Request API 格式）
  if ("messages" in message && Array.isArray(message.messages)) {
    const messageTexts = extractMessagesText(message.messages);
    texts.push(...messageTexts);
  }

  // 3. 提取 input（Response API 格式）
  if ("input" in message && Array.isArray(message.input)) {
    const inputTexts = extractInputText(message.input);
    texts.push(...inputTexts);
  }

  // 过滤空字符串
  return texts.filter((t) => t.length > 0);
}

/**
 * Extract only rerank query and document text, leaving opaque document fields alone.
 */
export function extractTextFromRerankRequest(message: Record<string, unknown>): string[] {
  const texts: string[] = [];

  if (typeof message.query === "string" && message.query.length > 0) {
    texts.push(message.query);
  }

  if (Array.isArray(message.documents)) {
    for (const document of message.documents) {
      if (typeof document === "string") {
        if (document.length > 0) {
          texts.push(document);
        }
      } else if (typeof document === "object" && document !== null && !Array.isArray(document)) {
        // Match the explicit text/content fields used by message blocks, without recursion.
        if ("text" in document && typeof document.text === "string" && document.text.length > 0) {
          texts.push(document.text);
        }
        if (
          "content" in document &&
          typeof document.content === "string" &&
          document.content.length > 0
        ) {
          texts.push(document.content);
        }
      }
    }
  }

  return texts;
}

function collectSystemOneText(
  value: unknown,
  texts: string[],
  assetPattern: RegExp | null,
  depth = 0
): void {
  if (depth > 64) return;
  if (typeof value === "string") {
    if (assetPattern === null) {
      if (value.length > 0) texts.push(value);
      return;
    }
    // Image spans separate text; removing them must not join unrelated words.
    assetPattern.lastIndex = 0;
    let start = 0;
    let match = assetPattern.exec(value);
    while (match !== null) {
      if (match.index > start) texts.push(value.slice(start, match.index));
      start = assetPattern.lastIndex;
      match = assetPattern.exec(value);
    }
    if (start < value.length) texts.push(value.slice(start));
  } else if (Array.isArray(value)) {
    for (const item of value) collectSystemOneText(item, texts, assetPattern, depth + 1);
  } else if (value !== null && typeof value === "object") {
    for (const [name, nested] of Object.entries(value)) {
      // Object keys stay model-visible text even when they equal an image reference.
      if (name.length > 0) texts.push(name);
      collectSystemOneText(nested, texts, assetPattern, depth + 1);
    }
  }
}

/** Inspect inference text, not images, asset references, question IDs, or transport metadata. */
export function extractTextFromSystemOneRequest(message: Record<string, unknown>): string[] {
  const texts: string[] = [];
  const references =
    message.assets !== null && typeof message.assets === "object" && !Array.isArray(message.assets)
      ? Object.keys(message.assets).filter((reference) => reference.length > 0)
      : [];
  // Literal, case-sensitive, non-overlapping matches; complete references win over prefixes.
  const assetPattern =
    references.length > 0
      ? new RegExp(
          references
            .sort((left, right) => right.length - left.length)
            .map((reference) => reference.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
            .join("|"),
          "g"
        )
      : null;
  collectSystemOneText(message.state, texts, assetPattern);
  if (
    message.questions === null ||
    typeof message.questions !== "object" ||
    Array.isArray(message.questions)
  ) {
    return texts;
  }
  for (const question of Object.values(message.questions)) {
    if (question === null || typeof question !== "object" || Array.isArray(question)) continue;
    const { instructions, criteria, type } = question as Record<string, unknown>;
    collectSystemOneText(instructions, texts, assetPattern);
    if (criteria !== null && typeof criteria === "object" && !Array.isArray(criteria)) {
      for (const [label, description] of Object.entries(criteria)) {
        if (type !== "noul" && label.length > 0) texts.push(label);
        collectSystemOneText(description, texts, assetPattern, 1);
      }
    } else {
      collectSystemOneText(criteria, texts, assetPattern);
    }
  }
  return texts;
}
