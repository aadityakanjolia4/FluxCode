"use strict";
/**
 * Token usage tracking across all LLM providers
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TokenTracker = void 0;
class TokenTracker {
    constructor() {
        this._tokens = [];
    }
    /**
     * Record a token usage event
     */
    trackTokens(provider, inputTokens, outputTokens) {
        this._tokens.push({
            inputTokens,
            outputTokens,
            totalTokens: inputTokens + outputTokens,
            requestCount: 1,
            provider,
            timestamp: Date.now(),
        });
    }
    /**
     * Get aggregated session statistics
     */
    getSessionStats() {
        const stats = {
            claude: { input: 0, output: 0, requests: 0 },
            gemini: { input: 0, output: 0, requests: 0 },
            mistral: { input: 0, output: 0, requests: 0 },
            totalRequests: 0,
            totalTokens: 0,
            estimatedCost: '$0.00',
        };
        for (const metric of this._tokens) {
            stats.totalRequests++;
            stats.totalTokens += metric.totalTokens;
            if (metric.provider === 'anthropic') {
                stats.claude.input += metric.inputTokens;
                stats.claude.output += metric.outputTokens;
                stats.claude.requests++;
            }
            else if (metric.provider === 'gemini') {
                stats.gemini.input += metric.inputTokens;
                stats.gemini.output += metric.outputTokens;
                stats.gemini.requests++;
            }
            else if (metric.provider === 'mistral') {
                stats.mistral.input += metric.inputTokens;
                stats.mistral.output += metric.outputTokens;
                stats.mistral.requests++;
            }
        }
        // Estimate cost (rough pricing)
        const claudeCost = (stats.claude.input * 0.003 + stats.claude.output * 0.015) / 1000;
        const geminiCost = (stats.gemini.input * 0.00075 + stats.gemini.output * 0.003) / 1000;
        const mistralCost = (stats.mistral.input * 0.00025 + stats.mistral.output * 0.00075) / 1000;
        const totalCost = claudeCost + geminiCost + mistralCost;
        stats.estimatedCost = `$${totalCost.toFixed(4)}`;
        return stats;
    }
    /**
     * Clear token history
     */
    clear() {
        this._tokens = [];
    }
    /**
     * Get all metrics
     */
    getMetrics() {
        return this._tokens;
    }
}
exports.TokenTracker = TokenTracker;
//# sourceMappingURL=tokenTracker.js.map