import WebSocket from "ws";
import dotenv from "dotenv";
import axios from "axios";
import fs from "fs";
import fetch, { Response } from "node-fetch";

dotenv.config();

const EnvVars = [
	"WHOP_API_KEY",
	"WHOP_AGENT_USER_ID",
	"WHOP_COMPANY_ID",
	"TARGET_FEED_ID",
	"OPENAI_API_KEY",
];

const missingEnvVars = EnvVars.filter(
	(varName) => !process.env[varName]
);
if (missingEnvVars.length > 0) {
	console.error(
		`Missing required environment variables: ${missingEnvVars.join(", ")}`
	);
	process.exit(1);
}

const WHOP_API_KEY = process.env.WHOP_API_KEY!;
const WHOP_AGENT_USER_ID = process.env.WHOP_AGENT_USER_ID!;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
const TARGET_FEED_ID = process.env.TARGET_FEED_ID!;

// Load knowledge base at startup
const KNOWLEDGE_PATH = "./lib/knowledge.txt";
let knowledgeBase = "";
try {
	knowledgeBase = fs.readFileSync(KNOWLEDGE_PATH, "utf-8");
	console.log("📚 Loaded knowledge base from", KNOWLEDGE_PATH);
} catch (err) {
	console.warn("⚠️ Could not load knowledge base:", err);
}

const headers = {
	"Content-Type": "application/json",
	Authorization: `Bearer ${WHOP_API_KEY}`,
	"x-on-behalf-of": WHOP_AGENT_USER_ID,
};

let ws: WebSocket | null = null;
let pingInterval: NodeJS.Timeout | null = null;

// Track processed DM entityIds to prevent double replies
const processedDMs = new Set<string>();

function connect() {
	ws = new WebSocket("wss://ws-prod.whop.com/ws/developer", { headers });

	ws.on("open", () => {
		console.log("🤖 Bot connected and ready for DMs");
	});

	ws.on("message", handleMessage);
	ws.on("close", handleClose);
	ws.on("error", handleError);
}

connect();

async function handleMessage(data: WebSocket.Data) {
	try {
		const rawMessage = data.toString();
		const message = JSON.parse(rawMessage);

		// Log the full message for debugging (optional)
		console.log("Received WebSocket message:", JSON.stringify(message, null, 2));

		// Check for DM messages in feedEntity.dmsPost format
		const dmsPost = message?.feedEntity?.dmsPost;
		if (dmsPost) {
			const entityId = dmsPost.entityId;
			if (typeof entityId !== "string" || !entityId) {
				console.log("❌ DM missing valid entityId, skipping deduplication.");
				return;
			}
			if (processedDMs.has(entityId)) {
				console.log("⏩ Skipping duplicate DM:", entityId);
				return;
			}
			processedDMs.add(entityId);
			if (processedDMs.size > 1000) {
				const first = processedDMs.values().next().value;
				if (typeof first === "string") {
					processedDMs.delete(first);
				}
			}

			// Log incoming DM
			const feedId = dmsPost.feedId;
			const messageContent = dmsPost.content;
			const senderId = dmsPost.userId;
			console.log("\n📥 Received DM:", {
				from: dmsPost.user?.name || senderId,
				message: messageContent,
				feedId: feedId,
			});

			if (feedId && messageContent && senderId) {
				// Avoid replying to our own messages
				if (senderId === WHOP_AGENT_USER_ID) {
					console.log("↩️  Ignoring own message");
					return;
				}

				// Generate AI response
				const aiResponse = await getAIReply(messageContent);
				if (aiResponse) {
					await sendWhopDM(feedId, aiResponse);
					console.log("📤 Sent response:", aiResponse);
				}
			} else {
				console.log("❌ Missing required DM data:", { feedId, messageContent, senderId });
			}
		}
	} catch (error) {
		console.error("❌ Error processing message:", error);
	}
}

function handleClose() {
	console.log("WebSocket connection closed");
	if (pingInterval) {
		clearInterval(pingInterval);
		pingInterval = null;
	}
}

function handleError(error: Error) {
	console.error("WebSocket error:", error);
}

async function getAIReply(message: string): Promise<string | null> {
	try {
		const res: Response = await fetch("https://api.openai.com/v1/chat/completions", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${OPENAI_API_KEY}`,
			},
			body: JSON.stringify({
				model: "gpt-4o",
				messages: [
					{ role: "system", content: "You are a helpful Whop support bot. Use the following knowledge base to answer questions.\n\n" + knowledgeBase },
					{ role: "user", content: message },
				],
				max_tokens: 200,
			}),
		});
		const data = await res.json() as any;
		return data.choices?.[0]?.message?.content?.trim() || null;
	} catch (err) {
		console.error("OpenAI error:", err);
		return null;
	}
}

async function sendWhopDM(feedId: string, message: string) {
	const graphqlQuery = {
		query: `mutation sendMessage($input: SendMessageInput!) { sendMessage(input: $input) }`,
		variables: {
			input: {
				feedId,
				feedType: "chat_feed",
				message,
			},
		},
	};
	try {
		const res: Response = await fetch("https://api.whop.com/public-graphql", {
			method: "POST",
			headers,
			body: JSON.stringify(graphqlQuery),
		});
		const data = await res.json() as any;
		if (data.errors) {
			console.error("Failed to send DM:", data.errors);
		}
		return data.data;
	} catch (err) {
		console.error("Failed to send DM:", err);
	}
}
  