import { test } from "node:test";
import { strict as assert } from "node:assert/strict";
import { priceInfo, budgetCheck } from "../src/models.mjs";

// Test cases for budget guard functionality

test("priceInfo reads from OpenRouter catalog", () => {
  const cfg = { budget: {}, staticPricing: {} };
  const orCatalog = { "qwen/qwen3-coder": { prompt: 0.3, completion: 1.0, context: 262144, tools: true } };
  const mdCatalog = {};
  
  const result = priceInfo("openrouter/qwen/qwen3-coder", cfg, orCatalog, mdCatalog);
  
  assert.equal(result.prompt, 0.3);
  assert.equal(result.completion, 1.0);
  assert.equal(result.context, 262144);
  assert.equal(result.tools, true);
  assert.equal(result.source, "openrouter");
});

test("priceInfo reads from models.dev catalog", () => {
  const cfg = { budget: {}, staticPricing: {} };
  const orCatalog = {};
  const mdCatalog = { opencode: { "glm-4.7": { prompt: 0.6, completion: 2.2, context: 204800, tools: true } } };
  
  const result = priceInfo("opencode/glm-4.7", cfg, orCatalog, mdCatalog);
  
  assert.equal(result.prompt, 0.6);
  assert.equal(result.completion, 2.2);
  assert.equal(result.context, 204800);
  assert.equal(result.tools, true);
  assert.equal(result.source, "models.dev");
});

test("staticPricing wins over both catalogs", () => {
  const cfg = { 
    budget: {}, 
    staticPricing: { "openrouter/qwen/qwen3-coder": { prompt: 0.1, completion: 0.2, context: 100000, tools: false } } 
  };
  const orCatalog = { "qwen/qwen3-coder": { prompt: 0.3, completion: 1.0, context: 262144, tools: true } };
  const mdCatalog = { opencode: { "glm-4.7": { prompt: 0.6, completion: 2.2, context: 204800, tools: true } } };
  
  const result = priceInfo("openrouter/qwen/qwen3-coder", cfg, orCatalog, mdCatalog);
  
  assert.equal(result.prompt, 0.1);
  assert.equal(result.completion, 0.2);
  assert.equal(result.context, 100000);
  assert.equal(result.tools, false);
  assert.equal(result.source, "static");
});

test("staticPricing glob pattern matches", () => {
  const cfg = { 
    budget: {}, 
    staticPricing: { "ollama/*": { prompt: 0.0, completion: 0.0, context: 128000, tools: true } } 
  };
  const orCatalog = {};
  const mdCatalog = {};
  
  const result = priceInfo("ollama/irgendwas", cfg, orCatalog, mdCatalog);
  
  assert.equal(result.prompt, 0.0);
  assert.equal(result.completion, 0.0);
  assert.equal(result.context, 128000);
  assert.equal(result.tools, true);
  assert.equal(result.source, "static:ollama/*");
});

test("budgetCheck rejects model with high input price", () => {
  const cfg = { 
    budget: { maxPromptUsdPerMTok: 0.5, maxCompletionUsdPerMTok: 1.0, minContext: 0 },
    staticPricing: {} 
  };
  const orCatalog = { "qwen/qwen3-coder": { prompt: 0.8, completion: 0.5, context: 262144, tools: true } };
  const mdCatalog = {};
  
  const result = budgetCheck("openrouter/qwen/qwen3-coder", cfg, orCatalog, { spentToday: 0, mdCatalog });
  
  assert.equal(result.allowed, false);
  assert.ok(result.reason.includes("input price $0.80"));
});

test("budgetCheck rejects model with high output price", () => {
  const cfg = { 
    budget: { maxPromptUsdPerMTok: 1.0, maxCompletionUsdPerMTok: 1.0, minContext: 0 },
    staticPricing: {} 
  };
  const orCatalog = { "qwen/qwen3-coder": { prompt: 0.5, completion: 1.5, context: 262144, tools: true } };
  const mdCatalog = {};
  
  const result = budgetCheck("openrouter/qwen/qwen3-coder", cfg, orCatalog, { spentToday: 0, mdCatalog });
  
  assert.equal(result.allowed, false);
  assert.ok(result.reason.includes("output price $1.50"));
});

test("budgetCheck rejects unpriced model unless allowUnpriced is true", () => {
  const cfg = { 
    budget: { maxPromptUsdPerMTok: 1.0, maxCompletionUsdPerMTok: 1.0, minContext: 0, allowUnpriced: false },
    staticPricing: {} 
  };
  const orCatalog = {};
  const mdCatalog = {};
  
  const result = budgetCheck("openrouter/unknown-model", cfg, orCatalog, { spentToday: 0, mdCatalog });
  
  assert.equal(result.allowed, false);
  assert.ok(result.reason.includes("no price known"));

  // Test with allowUnpriced enabled
  cfg.budget.allowUnpriced = true;
  const result2 = budgetCheck("openrouter/unknown-model", cfg, orCatalog, { spentToday: 0, mdCatalog });
  
  assert.equal(result2.allowed, true);
  assert.equal(result2.reason, "unpriced but allowUnpriced=true");
});

test("budgetCheck respects deny and allow lists", () => {
  const cfg = { 
    budget: { maxPromptUsdPerMTok: 1.0, maxCompletionUsdPerMTok: 1.0, minContext: 0, allow: [], deny: ["*claude*"] },
    staticPricing: {} 
  };
  const orCatalog = { "anthropic/claude-3-haiku": { prompt: 0.25, completion: 0.75, context: 262144, tools: true } };
  const mdCatalog = {};
  
  // Should be denied due to deny list
  const result = budgetCheck("anthropic/claude-3-haiku", cfg, orCatalog, { spentToday: 0, mdCatalog });
  
  assert.equal(result.allowed, false);
  assert.ok(result.reason.includes('denylist match "*claude*"'));
  
  // Test with allow override
  cfg.budget.allow = ["*claude*"];
  const result2 = budgetCheck("anthropic/claude-3-haiku", cfg, orCatalog, { spentToday: 0, mdCatalog });
  
  assert.equal(result2.allowed, true);
  assert.equal(result2.reason, "allowlisted");
});

test("budgetCheck rejects model without tool support when required", () => {
  const cfg = { 
    budget: { maxPromptUsdPerMTok: 1.0, maxCompletionUsdPerMTok: 1.0, minContext: 0, requireToolSupport: true },
    staticPricing: {} 
  };
  const orCatalog = { "qwen/qwen3-coder": { prompt: 0.5, completion: 0.5, context: 262144, tools: false } };
  const mdCatalog = {};
  
  const result = budgetCheck("openrouter/qwen/qwen3-coder", cfg, orCatalog, { spentToday: 0, mdCatalog });
  
  assert.equal(result.allowed, false);
  assert.ok(result.reason.includes("model has no tool calling"));
});

test("budgetCheck rejects model with insufficient context", () => {
  const cfg = { 
    budget: { maxPromptUsdPerMTok: 1.0, maxCompletionUsdPerMTok: 1.0, minContext: 200000, allowUnpriced: true },
    staticPricing: {} 
  };
  const orCatalog = { "qwen/qwen3-coder": { prompt: 0.5, completion: 0.5, context: 100000, tools: true } };
  const mdCatalog = {};
  
  const result = budgetCheck("openrouter/qwen/qwen3-coder", cfg, orCatalog, { spentToday: 0, mdCatalog });
  
  assert.equal(result.allowed, false);
  assert.ok(result.reason.includes("context 100000 below required 200000"));
});

test("budgetCheck rejects when daily limit is exceeded", () => {
  const cfg = { 
    budget: { maxPromptUsdPerMTok: 1.0, maxCompletionUsdPerMTok: 1.0, maxDailyUsd: 5.0, minContext: 0 },
    staticPricing: {} 
  };
  const orCatalog = { "qwen/qwen3-coder": { prompt: 0.5, completion: 0.5, context: 262144, tools: true } };
  const mdCatalog = {};
  
  const result = budgetCheck("openrouter/qwen/qwen3-coder", cfg, orCatalog, { spentToday: 10.0, mdCatalog });
  
  assert.equal(result.allowed, false);
  assert.ok(result.reason.includes("daily budget exhausted"));
  assert.equal(result.budgetStop, true);
});