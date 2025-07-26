import { analyzeToolHandler, analyzeToolSchema } from "../../Server/src/tools";
import { Logger } from "pino";
import fs from "fs/promises";
// import * as AIProviders from "../../Server/src/utils/ai-providers'; // No longer using wildcard import for mocks
import { Result } from "@modelcontextprotocol/sdk/types";
import { AIProvider } from "../../Server/src/types";
import { vi } from "vitest";
import { readImageAsBase64 } from "../../Server/src/utils/peekaboo-cli";

// Mock Logger
const mockLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn().mockReturnThis(),
  level: "info",
} as any;

// Mock fs.readFile
vi.mock("fs/promises", async () => ({
  ...(await vi.importActual("fs/promises")),
  readFile: vi.fn(),
  access: vi.fn().mockResolvedValue(undefined),
}));

// Mock the readImageAsBase64 function
vi.mock("../../Server/src/utils/peekaboo-cli", () => ({
  readImageAsBase64: vi.fn(),
  executeSwiftCli: vi.fn(), // Also mock this if analyzeToolHandler somehow uses it
}));

const mockReadImageAsBase64 = readImageAsBase64 as vi.MockedFunction<
  typeof readImageAsBase64
>;

// --- Advanced Mocking Strategy for ai-providers ---
// These will hold the current mock implementations for each function.
// Tests will modify these variables to change mock behavior.
let currentParseAIProvidersImpl: (...args: any[]) => AIProvider[] = () => [];
let currentIsProviderAvailableImpl: (
  ...args: any[]
) => Promise<boolean> = async () => false;
let currentAnalyzeImageWithProviderImpl: (
  ...args: any[]
) => Promise<string> = async () => "Mocked AI Response";
let currentGetDefaultModelForProviderImpl: (...args: any[]) => string = () =>
  "unknown-default";
let currentDetermineProviderAndModelImpl: (
  ...args: any[]
) => Promise<{ provider: string | null; model: string }> = async () => ({
  provider: "ollama",
  model: "default-model",
});

// Consolidated mock for ai-providers module
vi.mock("../../Server/src/utils/ai-providers", () => ({
  __esModule: true,
  // The mocked functions will call the current implementations stored in the variables above.
  parseAIProviders: (...args: any[]) => currentParseAIProvidersImpl(...args),
  isProviderAvailable: (...args: any[]) =>
    currentIsProviderAvailableImpl(...args),
  analyzeImageWithProvider: (...args: any[]) =>
    currentAnalyzeImageWithProviderImpl(...args),
  getDefaultModelForProvider: (...args: any[]) =>
    currentGetDefaultModelForProviderImpl(...args),
  determineProviderAndModel: (...args: any[]) =>
    currentDetermineProviderAndModelImpl(...args),
}));
// --- End of Advanced Mocking Strategy ---

const MOCK_IMAGE_PATH = "/mock/path/to/image.png";
const MOCK_IMAGE_BASE64 = "mockbase64string";
const MOCK_QUESTION = "What is in this image?";

// Conditionally skip Swift-dependent tests on non-macOS platforms
const describeSwiftTests = globalThis.shouldSkipSwiftTests ? describe.skip : describe;

describeSwiftTests("analyzeToolHandler Integration Tests", () => {
  let originalReadFileMock: vi.Mock;

  beforeEach(async () => {
    const mockedFs = await import("fs/promises");
    originalReadFileMock = mockedFs.readFile as vi.Mock;

    currentParseAIProvidersImpl = () => [];
    currentIsProviderAvailableImpl = async () => false;
    currentAnalyzeImageWithProviderImpl = async () => "Mocked AI Response";
    currentGetDefaultModelForProviderImpl = (provider: string) => {
      if (provider === "ollama") return "default-ollama-model";
      if (provider === "openai") return "default-openai-model";
      return "unknown-default";
    };
    currentDetermineProviderAndModelImpl = async () => ({
      provider: "ollama",
      model: "default-model",
    });

    originalReadFileMock.mockClear();
    originalReadFileMock.mockResolvedValue(
      Buffer.from(MOCK_IMAGE_BASE64, "base64"),
    );
    
    // Mock readImageAsBase64 to return our test base64 string
    mockReadImageAsBase64.mockResolvedValue(MOCK_IMAGE_BASE64);

    process.env.PEEKABOO_AI_PROVIDERS = "";
    process.env.OPENAI_API_KEY = "";
    process.env.PEEKABOO_OLLAMA_BASE_URL = "http://localhost:11434";
  });

  it("should return error if PEEKABOO_AI_PROVIDERS is not configured (env var is empty)", async () => {
    const args = analyzeToolSchema.parse({
      image_path: MOCK_IMAGE_PATH,
      question: MOCK_QUESTION,
    });
    const response: Result = await analyzeToolHandler(args, {
      logger: mockLogger,
    });
    expect(response.isError).toBe(true);
    const content = response.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.text).toContain(
      "AI analysis not configured on this server",
    );
  });

  it("should return error if image_path has an unsupported extension", async () => {
    process.env.PEEKABOO_AI_PROVIDERS = "mocked_providers_exist"; // Allow to proceed past initial check
    currentParseAIProvidersImpl = () => [
      { provider: "ollama", model: "llava" },
    ];
    const args = analyzeToolSchema.parse({
      image_path: "/mock/image.txt",
      question: MOCK_QUESTION,
    });
    const response: Result = await analyzeToolHandler(args, {
      logger: mockLogger,
    });
    expect(response.isError).toBe(true);
    const content = response.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.text).toContain(
      "Unsupported image format: .txt. Supported formats: .png, .jpg, .jpeg, .webp",
    );
  });

  it("should successfully call specified provider (Ollama) if available", async () => {
    process.env.PEEKABOO_AI_PROVIDERS = "mocked_providers_exist"; // Allow to proceed
    const ollamaProvider: AIProvider = { provider: "ollama", model: "llava" };
    currentParseAIProvidersImpl = () => [ollamaProvider];
    currentIsProviderAvailableImpl = async (p: AIProvider) =>
      p.provider === "ollama";
    currentAnalyzeImageWithProviderImpl = async () =>
      "Ollama says: Test successful";
    const requestedModel = "custom-ollama-model";
    currentDetermineProviderAndModelImpl = async () => ({
      provider: "ollama",
      model: requestedModel,
    });
    const args = analyzeToolSchema.parse({
      image_path: MOCK_IMAGE_PATH,
      question: MOCK_QUESTION,
      provider_config: { type: "ollama", model: requestedModel },
    });
    const response: Result = await analyzeToolHandler(args, {
      logger: mockLogger,
    });
    expect(response.isError).not.toBe(true);
    expect(response.analysis_text).toBe("Ollama says: Test successful");
    expect(response.model_used).toBe(`ollama/${requestedModel}`);
  });

  it("should successfully call specified provider (OpenAI) if available, using model from PEEKABOO_AI_PROVIDERS if not specified in call", async () => {
    process.env.PEEKABOO_AI_PROVIDERS = "mocked_providers_exist"; // Allow to proceed
    const envOpenAIProvider: AIProvider = {
      provider: "openai",
      model: "gpt-4-from-env",
    };
    currentParseAIProvidersImpl = () => [envOpenAIProvider];
    currentIsProviderAvailableImpl = async (p: AIProvider) =>
      p.provider === "openai";
    currentAnalyzeImageWithProviderImpl = async () =>
      "OpenAI says: Test successful";
    currentDetermineProviderAndModelImpl = async () => ({
      provider: "openai",
      model: "gpt-4-from-env",
    });
    process.env.OPENAI_API_KEY = "test-key";
    const args = analyzeToolSchema.parse({
      image_path: MOCK_IMAGE_PATH,
      question: MOCK_QUESTION,
      provider_config: { type: "openai" },
    });
    const response: Result = await analyzeToolHandler(args, {
      logger: mockLogger,
    });
    expect(response.isError).not.toBe(true);
    expect(response.analysis_text).toBe("OpenAI says: Test successful");
    expect(response.model_used).toBe("openai/gpt-4-from-env");
  });

  it("should use auto provider selection (first available from PEEKABOO_AI_PROVIDERS)", async () => {
    process.env.PEEKABOO_AI_PROVIDERS = "mocked_providers_exist"; // Allow to proceed
    const ollamaProviderEnv: AIProvider = {
      provider: "ollama",
      model: "ollama-model-from-env",
    };
    const openaiProviderEnv: AIProvider = {
      provider: "openai",
      model: "openai-model-from-env",
    };
    currentParseAIProvidersImpl = () => [ollamaProviderEnv, openaiProviderEnv];
    currentIsProviderAvailableImpl = async (p: AIProvider) =>
      p.provider === "ollama";
    currentAnalyzeImageWithProviderImpl = async () =>
      "Auto-selected Ollama response";
    currentDetermineProviderAndModelImpl = async () => ({
      provider: "ollama",
      model: "ollama-model-from-env",
    });
    const args = analyzeToolSchema.parse({
      image_path: MOCK_IMAGE_PATH,
      question: MOCK_QUESTION,
    });
    const response: Result = await analyzeToolHandler(args, {
      logger: mockLogger,
    });
    expect(response.isError).not.toBe(true);
    expect(response.analysis_text).toBe("Auto-selected Ollama response");
    expect(response.model_used).toBe("ollama/ollama-model-from-env");
  });

  it("should fallback to next provider if first in auto selection is unavailable", async () => {
    process.env.PEEKABOO_AI_PROVIDERS = "mocked_providers_exist"; // Allow to proceed
    const ollamaProviderEnv: AIProvider = {
      provider: "ollama",
      model: "ollama-model",
    };
    const openaiProviderEnv: AIProvider = {
      provider: "openai",
      model: "openai-model",
    };
    currentParseAIProvidersImpl = () => [ollamaProviderEnv, openaiProviderEnv];
    currentIsProviderAvailableImpl = async (p: AIProvider) => {
      if (p.provider === "ollama") return false;
      if (p.provider === "openai") return true;
      return false;
    };
    process.env.OPENAI_API_KEY = "test-key";
    currentAnalyzeImageWithProviderImpl = async () =>
      "Fallback OpenAI response";
    currentDetermineProviderAndModelImpl = async () => ({
      provider: "openai",
      model: "openai-model",
    });
    const args = analyzeToolSchema.parse({
      image_path: MOCK_IMAGE_PATH,
      question: MOCK_QUESTION,
    });
    const response: Result = await analyzeToolHandler(args, {
      logger: mockLogger,
    });
    expect(response.isError).not.toBe(true);
    expect(response.analysis_text).toBe("Fallback OpenAI response");
    expect(response.model_used).toBe("openai/openai-model");
  });

  it("should return error if no configured providers are available during auto selection", async () => {
    process.env.PEEKABOO_AI_PROVIDERS = "mocked_providers_exist"; // Allow to proceed
    currentParseAIProvidersImpl = () => [
      { provider: "ollama", model: "llava" },
    ]; // Configured one provider
    currentIsProviderAvailableImpl = async () => false; // But it's not available
    // Mock determineProviderAndModel to return null provider when no providers are available
    currentDetermineProviderAndModelImpl = async () => ({
      provider: null,
      model: "",
    });
    const args = analyzeToolSchema.parse({
      image_path: MOCK_IMAGE_PATH,
      question: MOCK_QUESTION,
    });
    const response: Result = await analyzeToolHandler(args, {
      logger: mockLogger,
    });
    expect(response.isError).toBe(true);
    const content = response.content as Array<{ type: string; text?: string }>;
    // This error comes from determineProviderAndModel when no provider is operational.
    // analyzeToolHandler wraps this specific error.
    expect(content[0]?.text).toBe(
      "No configured AI providers are currently operational.",
    );
  });

  it("should handle error from analyzeImageWithProvider", async () => {
    process.env.PEEKABOO_AI_PROVIDERS = "mocked_providers_exist"; // Allow to proceed
    const ollamaProvider: AIProvider = { provider: "ollama", model: "llava" };
    currentParseAIProvidersImpl = () => [ollamaProvider];
    currentIsProviderAvailableImpl = async () => true;
    currentAnalyzeImageWithProviderImpl = async () => {
      throw new Error("Ollama connection refused");
    };
    currentDetermineProviderAndModelImpl = async () => ({
      provider: "ollama",
      model: "llava",
    });
    const args = analyzeToolSchema.parse({
      image_path: MOCK_IMAGE_PATH,
      question: MOCK_QUESTION,
    });
    const response: Result = await analyzeToolHandler(args, {
      logger: mockLogger,
    });
    expect(response.isError).toBe(true);
    const content = response.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.text).toContain(
      "AI analysis failed: Ollama connection refused",
    );
    expect((response._meta as any)?.backend_error_code).toBe(
      "AI_PROVIDER_ERROR",
    );
  });

  it("should use default model for a provider if not specified in PEEKABOO_AI_PROVIDERS string and not in call", async () => {
    process.env.PEEKABOO_AI_PROVIDERS = "mocked_providers_exist"; // Allow to proceed
    const ollamaParsedProvider: AIProvider = { provider: "ollama", model: "" };
    currentParseAIProvidersImpl = () => [ollamaParsedProvider];
    currentIsProviderAvailableImpl = async (p: AIProvider) =>
      p.provider === "ollama";
    const defaultModel = "default-llava-model-for-test";
    currentGetDefaultModelForProviderImpl = () => defaultModel;
    currentAnalyzeImageWithProviderImpl = async () =>
      "Ollama default model response";
    currentDetermineProviderAndModelImpl = async () => ({
      provider: "ollama",
      model: defaultModel,
    });
    const args = analyzeToolSchema.parse({
      image_path: MOCK_IMAGE_PATH,
      question: MOCK_QUESTION,
      provider_config: { type: "ollama" },
    });
    const response: Result = await analyzeToolHandler(args, {
      logger: mockLogger,
    });
    expect(response.isError).not.toBe(true);
    expect(response.analysis_text).toBe("Ollama default model response");
    expect(response.model_used).toBe(`ollama/${defaultModel}`);
  });

  it("should return error if parseAIProviders returns empty even if PEEKABOO_AI_PROVIDERS env is set", async () => {
    process.env.PEEKABOO_AI_PROVIDERS = "some,csv,string"; // Env var is set
    currentParseAIProvidersImpl = () => []; // But parsing yields no valid providers

    const args = analyzeToolSchema.parse({
      image_path: MOCK_IMAGE_PATH,
      question: MOCK_QUESTION,
    });
    const response: Result = await analyzeToolHandler(args, {
      logger: mockLogger,
    });

    expect(response.isError).toBe(true);
    const content = response.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.text).toBe(
      "No valid AI providers found in PEEKABOO_AI_PROVIDERS configuration.",
    );
  });
});
