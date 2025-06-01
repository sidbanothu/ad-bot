import WebSocket from "ws";
import dotenv from "dotenv";
import fs from "fs/promises";
import fetch, { Response } from "node-fetch";

dotenv.config();

const BOT_DISPLAY_NAME = "@ad-bot's agent";

// ============================================================================
// TYPES & INTERFACES
// ============================================================================
interface Conversation {
	messages: Array<{ role: 'system' | 'user' | 'assistant', content: string }>;
	lastUpdated: number;
}

interface BotState {
	isActive: boolean;
	lastToggleTime: number;
	debugMode: boolean;
}

interface RateLimit {
	count: number;
	resetTime: number;
}

interface WhopDMPost {
	entityId: string;
	feedId: string;
	userId: string;
	content: string;
	user?: { name?: string };
	replyingToPostId?: string;
}

interface WhopMessage {
	feedEntity?: {
		dmsPost?: WhopDMPost;
		postReactionCountUpdate?: any;
	};
	broadcastResponse?: { typingIndicator?: boolean };
	goFetchNotifications?: boolean;
	marketplaceStats?: boolean;
	experiencePreviewContent?: boolean;
	channelSubscriptionState?: boolean;
	accessPassMember?: boolean;
}

// ============================================================================
// CONFIGURATION
// ============================================================================
const REQUIRED_ENV_VARS = [
	"WHOP_API_KEY",
	"WHOP_AGENT_USER_ID", 
	"WHOP_COMPANY_ID",
	"TARGET_FEED_ID",
	"OPENAI_API_KEY",
	"BOT_ADMIN_USER_ID",
] as const;

// Validate environment variables
const missingEnvVars = REQUIRED_ENV_VARS.filter(varName => !process.env[varName]);
if (missingEnvVars.length > 0) {
	console.error(`❌ Missing required environment variables: ${missingEnvVars.join(", ")}`);
	process.exit(1);
}

const CONFIG = {
	whop: {
		key: process.env.WHOP_API_KEY!,
		agentId: process.env.WHOP_AGENT_USER_ID!,
		companyId: process.env.WHOP_COMPANY_ID!,
		targetFeedId: process.env.TARGET_FEED_ID!,
		wsEndpoint: "wss://ws-prod.whop.com/ws/developer",
		graphqlEndpoint: "https://api.whop.com/public-graphql",
	},
	openai: {
		key: process.env.OPENAI_API_KEY!,
		endpoint: "https://api.openai.com/v1/chat/completions",
		model: "gpt-4",
	},
	admin: {
		userId: process.env.BOT_ADMIN_USER_ID!,
	},
	rateLimit: {
		globalMax: 100,
		globalWindowMs: 60 * 1000, // 1 minute
		userMax: 5,
		userWindowMs: 60 * 1000, // 1 minute
		cooldownMs: 15 * 60 * 1000, // 15 minutes between responses
		toggleCooldownMs: 60 * 1000, // 1 minute
	},
	conversation: {
		maxMessages: 10,
		timeoutMs: 30 * 60 * 1000, // 30 minutes
	}
} as const;

// ============================================================================
// STATE MANAGEMENT
// ============================================================================
let ws: WebSocket | null = null;
let systemPrompt = "";
let offersDatabase = "";

const botState: BotState = {
	isActive: true,
	lastToggleTime: Date.now(),
	debugMode: false
};

const processedDMs = new Set<string>();
const conversationHistory = new Map<string, Conversation>();
const userRateLimits = new Map<string, RateLimit>();
const lastResponseTimes = new Map<string, number>();
const conversationState = new Map<string, { lastBotResponseTime: number, lastBotResponseUserId: string }>();
const userMessageHistory = new Map<string, { messages: string[]; timestamps: number[]; spamUntil?: number }>();
let globalResponseTimestamps: number[] = [];

let globalRateLimit = {
	count: 0,
	resetTime: Date.now() + CONFIG.rateLimit.globalWindowMs
};

const botPostIds = new Set<string>();

const respondedUsersPerFeed = new Map<string, Set<string>>();

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================
function isSystemMessage(message: WhopMessage): boolean {
	return !!(
		message.goFetchNotifications ||
		message.marketplaceStats ||
		message.experiencePreviewContent ||
		message.channelSubscriptionState ||
		message.accessPassMember ||
		message.broadcastResponse?.typingIndicator ||
		message.feedEntity?.postReactionCountUpdate
	);
}

function shouldIgnoreContent(content: string): boolean {
	const lower = content.toLowerCase().trim();
	
	// Empty or very short messages
	if (lower.length < 3) return true;
	
	// Common chat patterns to ignore
	const ignorePatterns = [
		/^(lol|haha|ok|cool|nice|thanks?|ty|hi|hello|hey)$/,
		/^(good morning|good night|what's up|how are you)$/,
		/^(brb|afk|back|ping|pong)$/,
		/^(😂|😅|👍|💯|🔥)$/,
	];
	
	if (ignorePatterns.some(pattern => pattern.test(lower))) return true;
	
	// Must contain relevant keywords
	const relevantKeywords = [
		'deal', 'offer', 'promo', 'sale', 'discount', 'free', 'cheap',
		'price', 'cost', 'save', 'worth', 'recommend', 'suggestion',
		'looking', 'need', 'want', 'trying', 'find', 'buy',
		'nike', 'adidas', 'starbucks', 'uber', 'netflix', 'amazon',
		'trading', 'crypto', 'business', 'coaching'
	];
	
	return !relevantKeywords.some(keyword => lower.includes(keyword));
}

function isRateLimited(userId: string): boolean {
	const now = Date.now();
	const userLimit = userRateLimits.get(userId);
	
	if (!userLimit || now > userLimit.resetTime) {
		userRateLimits.set(userId, { 
			count: 1, 
			resetTime: now + CONFIG.rateLimit.userWindowMs 
		});
		return false;
	}
	
	if (userLimit.count >= CONFIG.rateLimit.userMax) return true;
	
	userLimit.count++;
	return false;
}

function isGloballyRateLimited(): boolean {
	const now = Date.now();
	
	if (now > globalRateLimit.resetTime) {
		globalRateLimit = {
			count: 0,
			resetTime: now + CONFIG.rateLimit.globalWindowMs
		};
	}
	
	if (globalRateLimit.count >= CONFIG.rateLimit.globalMax) return true;
	
	globalRateLimit.count++;
	return false;
}

function isInCooldown(feedId: string, userId: string): boolean {
	const last = conversationState.get(feedId);
	const now = Date.now();
	if (!last) return false;
	// Allow follow-up if same user and within 3 minutes (180000 ms)
	if (last.lastBotResponseUserId === userId && (now - last.lastBotResponseTime < 3 * 60 * 1000)) {
		return false;
	}
	// Otherwise, apply normal cooldown
	return now - last.lastBotResponseTime < CONFIG.rateLimit.cooldownMs;
}

function cleanupProcessedDMs(): void {
	if (processedDMs.size > 1000) {
		const oldest = processedDMs.values().next().value;
		if (oldest) processedDMs.delete(oldest);
	}
}

// ============================================================================
// API FUNCTIONS
// ============================================================================
const headers = {
	"Content-Type": "application/json",
	Authorization: `Bearer ${CONFIG.whop.key}`,
	"x-on-behalf-of": CONFIG.whop.agentId,
};

async function sendTypingIndicator(feedId: string, isTyping: boolean): Promise<void> {
	const query = {
		query: `mutation setTypingIndicator($input: SetTypingIndicatorInput!) { 
			setTypingIndicator(input: $input) 
		}`,
		variables: {
			input: { feedId, feedType: "chat_feed", isTyping }
		}
	};

	try {
		await fetch(CONFIG.whop.graphqlEndpoint, {
			method: "POST",
			headers,
			body: JSON.stringify(query)
		});
	} catch (error) {
		console.error("Failed to send typing indicator:", error);
	}
}

async function sendMessage(feedId: string, message: string): Promise<void> {
	const query = {
		query: `mutation sendMessage($input: SendMessageInput!) { 
			sendMessage(input: $input) 
		}`,
		variables: {
			input: { feedId, feedType: "chat_feed", message }
		}
	};

	const response = await fetch(CONFIG.whop.graphqlEndpoint, {
		method: "POST",
		headers,
		body: JSON.stringify(query)
	});

	const data: any = await response.json();
	console.log("[DEBUG] sendMessage API response:", JSON.stringify(data, null, 2));

	if (!response.ok) {
		throw new Error(`Whop API error: ${response.status} ${response.statusText}`);
	}

	if (data && data.data && typeof data.data.sendMessage === 'string') {
		botPostIds.add(data.data.sendMessage);
		console.log(`[TRACK] Added bot post ID: ${data.data.sendMessage}`);
	}
}

async function getAIResponse(message: string, feedId: string): Promise<string | null> {
	try {
		// Get or create conversation
		let conversation = conversationHistory.get(feedId);
		if (!conversation || Date.now() - conversation.lastUpdated > CONFIG.conversation.timeoutMs) {
			conversation = {
				messages: [{
					role: "system",
					content: `You are a helpful bot in a group chat. Only respond when someone is genuinely looking for deals, offers, or recommendations. Be natural and concise.\n\n${systemPrompt}\n\n${offersDatabase}`
				}],
				lastUpdated: Date.now()
			};
		}

		// Add user message
		conversation.messages.push({ role: "user", content: message });

		// Trim if too long
		if (conversation.messages.length > CONFIG.conversation.maxMessages) {
			conversation.messages = [
				conversation.messages[0], // Keep system message
				...conversation.messages.slice(-CONFIG.conversation.maxMessages + 1)
			];
		}

		const response = await fetch(CONFIG.openai.endpoint, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${CONFIG.openai.key}`,
			},
			body: JSON.stringify({
				model: CONFIG.openai.model,
				messages: conversation.messages,
				max_tokens: 150,
				temperature: 0.7,
			}),
		});

		if (!response.ok) {
			throw new Error(`OpenAI API error: ${response.status}`);
		}

		const data = await response.json() as any;
		const aiResponse = data.choices?.[0]?.message?.content?.trim();

		if (aiResponse) {
			// Update conversation
			conversation.messages.push({ role: "assistant", content: aiResponse });
			conversation.lastUpdated = Date.now();
			conversationHistory.set(feedId, conversation);
		}

		return aiResponse || null;
	} catch (error) {
		console.error("AI response error:", error);
		return null;
	}
}

// ============================================================================
// ADMIN COMMANDS
// ============================================================================
function handleAdminCommand(message: string, userId: string): string | null {
	if (userId !== CONFIG.admin.userId || !message.toLowerCase().startsWith('!bot')) {
		return null;
	}

	const command = message.toLowerCase().trim();
	
	switch (command) {
		case '!bot on':
			if (botState.isActive) return "🤖 Bot is already active!";
			botState.isActive = true;
			return "✅ Bot activated!";
			
		case '!bot off':
			if (!botState.isActive) return "🤖 Bot is already inactive!";
			botState.isActive = false;
			return "🛑 Bot deactivated!";
			
		case '!bot status':
			const timeUntilReset = Math.ceil((globalRateLimit.resetTime - Date.now()) / 1000);
			return `🤖 Status:\n• Active: ${botState.isActive ? '✅' : '❌'}\n• Debug: ${botState.debugMode ? '✅' : '❌'}\n• Rate Limit: ${globalRateLimit.count}/${CONFIG.rateLimit.globalMax}\n• Reset in: ${timeUntilReset}s`;
			
		case '!bot debug on':
			botState.debugMode = true;
			return "🔍 Debug mode activated!";
			
		case '!bot debug off':
			botState.debugMode = false;
			return "🔍 Debug mode deactivated!";
			
		case '!bot help':
			return `🤖 Commands:\n• !bot on/off - Toggle bot\n• !bot status - Check status\n• !bot debug on/off - Toggle debug\n• !bot help - Show this help`;
			
		default:
			return "❓ Unknown command. Use !bot help for available commands.";
	}
}

// ============================================================================
// MESSAGE HANDLING
// ============================================================================
async function handleMessage(data: WebSocket.Data): Promise<void> {
	try {
		const message = JSON.parse(data.toString()) as WhopMessage;
		
		// Ignore system messages
		if (isSystemMessage(message)) return;
		
		const dmsPost = message?.feedEntity?.dmsPost;
		if (!dmsPost) return;

		// Only respond once per unique entityId
		if (processedDMs.has(dmsPost.entityId)) {
			if (botState.debugMode) {
				console.log(`⏩ Already processed message: ${dmsPost.entityId}`);
			}
			return;
		}
		processedDMs.add(dmsPost.entityId);
		// Optionally, clean up old IDs if the set grows too large
		if (processedDMs.size > 1000) {
			processedDMs.clear();
		}

		// Handle admin commands first
		const adminResponse = handleAdminCommand(dmsPost.content, dmsPost.userId);
		if (adminResponse) {
			await sendMessage(dmsPost.feedId, adminResponse);
			return;
		}

		// If bot is inactive, ignore all other messages
		if (!botState.isActive) {
			if (botState.debugMode) {
				console.log("🤖 Bot inactive, ignoring message");
			}
			return;
		}

		// Ignore own messages
		if (dmsPost.userId === CONFIG.whop.agentId) return;

		// Global flood control
		const now = Date.now();
		const oneMinuteAgo = now - 60 * 1000;
		globalResponseTimestamps = globalResponseTimestamps.filter(ts => ts > oneMinuteAgo);
		if (globalResponseTimestamps.length >= 20) {
			console.log(`[FLOOD] Global response limit hit (${globalResponseTimestamps.length} in last minute). Skipping message from ${dmsPost.user?.name || dmsPost.userId}`);
			return;
		}

		// Spam protection
		let userHistory = userMessageHistory.get(dmsPost.userId);
		if (!userHistory) {
			userHistory = { messages: [], timestamps: [] };
			userMessageHistory.set(dmsPost.userId, userHistory);
		}
		const twoMinutesAgo = now - 2 * 60 * 1000;
		userHistory.messages = userHistory.messages.filter((_, i) => userHistory.timestamps[i] > twoMinutesAgo);
		userHistory.timestamps = userHistory.timestamps.filter(ts => ts > twoMinutesAgo);
		if (userHistory.spamUntil && now < userHistory.spamUntil) {
			console.log(`[SPAM] Ignoring user ${dmsPost.user?.name || dmsPost.userId} until ${new Date(userHistory.spamUntil).toISOString()}`);
			return;
		}
		userHistory.messages.push(dmsPost.content);
		userHistory.timestamps.push(now);
		const msgCount = userHistory.messages.filter(m => m === dmsPost.content).length;
		if (msgCount >= 3) {
			userHistory.spamUntil = now + 5 * 60 * 1000;
			console.log(`[SPAM] User ${dmsPost.user?.name || dmsPost.userId} flagged for spam for 5 minutes (sent same message 3+ times in 2 minutes)`);
			return;
		}

		// In handleMessage, before content filtering:
		const botMentioned = dmsPost.content.toLowerCase().includes(BOT_DISPLAY_NAME.toLowerCase());
		const isReplyToBot = dmsPost.replyingToPostId && botPostIds.has(dmsPost.replyingToPostId);
		const feedId = dmsPost.feedId;
		const userId = dmsPost.userId;
		let respondedSet = respondedUsersPerFeed.get(feedId);
		if (!respondedSet) {
			respondedSet = new Set();
			respondedUsersPerFeed.set(feedId, respondedSet);
		}

		// Proactive/reactive logic
		if (!respondedSet.has(userId)) {
			// User has not received a bot response in this feed
			if (shouldIgnoreContent(dmsPost.content)) {
				console.log(`[IGNORE] Content filtered (proactive): "${dmsPost.content}" from ${dmsPost.user?.name || userId} in feed ${feedId}`);
				return;
			}
			// No cooldown for new user's first relevant message
			console.log(`[PROACTIVE] Responding to new user ${dmsPost.user?.name || userId} in feed ${feedId} (no cooldown)`);
			// After responding, add user to set (done after sendMessage)
		} else {
			// User has already received a bot response in this feed
			// Cooldown applies only to further proactive messages
			if (!botMentioned && !isReplyToBot) {
				if (isInCooldown(feedId, userId)) {
					console.log(`[COOLDOWN] Conversation in cooldown for feed ${feedId}, user ${dmsPost.user?.name || userId} (proactive)`);
					return;
				}
				console.log(`[IGNORE] Message ignored (reactive): "${dmsPost.content}" from ${dmsPost.user?.name || userId} in feed ${feedId} (already responded, not a mention or reply)`);
				return;
			}
			if (botMentioned) {
				console.log(`[MENTION] Allowing message because bot was mentioned by ${dmsPost.user?.name || userId} (cooldown skipped).`);
			}
			if (isReplyToBot) {
				console.log(`[REPLY] Allowing message because it is a reply to a bot message by ${dmsPost.user?.name || userId} (cooldown skipped).`);
			}
		}

		// Rate limiting
		if (isGloballyRateLimited()) {
			console.log(`[RATE LIMIT] Global rate limit reached. Skipping message from ${dmsPost.user?.name || dmsPost.userId}`);
			return;
		}
		if (isRateLimited(dmsPost.userId)) {
			console.log(`[RATE LIMIT] User rate limited: ${dmsPost.user?.name || dmsPost.userId}`);
			return;
		}

		console.log(`[PROCESS] Generating response for ${dmsPost.user?.name || dmsPost.userId}: "${dmsPost.content}"`);

		// Send typing indicator and generate response
		await sendTypingIndicator(dmsPost.feedId, true);
		
		const aiResponse = await getAIResponse(dmsPost.content, dmsPost.feedId);
		
		await sendTypingIndicator(dmsPost.feedId, false);

		if (aiResponse) {
			// Mention the user in the response
			const userMention = dmsPost.user?.name ? `@${dmsPost.user.name}` : `@${dmsPost.userId}`;
			const finalResponse = `${userMention}, ${aiResponse}`;
			await sendMessage(dmsPost.feedId, finalResponse);
			conversationState.set(dmsPost.feedId, {
				lastBotResponseTime: Date.now(),
				lastBotResponseUserId: dmsPost.userId
			});
			globalResponseTimestamps.push(Date.now());
			console.log(`[SENT] Sent response to ${dmsPost.user?.name || dmsPost.userId}: "${finalResponse}"`);

			if (!respondedSet.has(userId)) {
				respondedSet.add(userId);
				console.log(`[TRACK] Added user ${dmsPost.user?.name || userId} to responded set for feed ${feedId}`);
			}
		} else {
			console.log(`[NO RESPONSE] No AI response generated for ${dmsPost.user?.name || dmsPost.userId}`);
		}

		console.log('[DEBUG] dmsPost object:', JSON.stringify(dmsPost, null, 2));

	} catch (error) {
		console.error("❌ Message handling error:", error);
	}
}

// ============================================================================
// WEBSOCKET CONNECTION
// ============================================================================
function connect(): void {
	ws = new WebSocket(CONFIG.whop.wsEndpoint, { headers });

	ws.on("open", () => {
		console.log("🤖 Bot connected and ready!");
	});

	ws.on("message", handleMessage);
	
	ws.on("close", () => {
		console.log("❌ WebSocket connection closed. Reconnecting in 5s...");
		setTimeout(connect, 5000);
	});

	ws.on("error", (error) => {
		console.error("❌ WebSocket error:", error);
	});
}

// ============================================================================
// INITIALIZATION
// ============================================================================
async function initializeBot(): Promise<void> {
	try {
		// Load knowledge files
		systemPrompt = await fs.readFile("./lib/knowledge/prompts.txt", "utf-8");
		offersDatabase = await fs.readFile("./lib/knowledge/offers.txt", "utf-8");
		
		console.log("📚 Loaded knowledge base");
		console.log(`🤖 Bot admin: ${CONFIG.admin.userId}`);
		console.log(`🎯 Target feed: ${CONFIG.whop.targetFeedId}`);
		
		// Start WebSocket connection
		connect();
		
	} catch (error) {
		console.error("❌ Bot initialization failed:", error);
		process.exit(1);
	}
}

// Start the bot
initializeBot().catch(error => {
	console.error("❌ Fatal error:", error);
	process.exit(1);
});