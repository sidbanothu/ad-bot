// ============================================================================
// IMPORTS & CONFIGURATION
// ============================================================================
import fs from "fs";
import fetch from "node-fetch";

// ============================================================================
// TYPES & INTERFACES
// ============================================================================
export interface Offer {
    name: string;
    description: string;
    url?: string;
    category: string;
    keywords: string[];
    value: number;
    urgency: 'low' | 'medium' | 'high';
}

export interface OfferMatch {
    offer: string;
    relevanceScore: number;
    category: string;
    reasoning: string;
}

export interface MessageAnalysis {
    intent: 'seeking_deal' | 'asking_question' | 'general_interest' | 'not_relevant';
    category: string;
    confidence: number;
    shouldRespond: boolean;
    specificBrands: string[];
    urgencyLevel: 'low' | 'medium' | 'high';
}

// ============================================================================
// OFFER DATABASE
// ============================================================================
let offerDatabase: Offer[] = [];

export function parseOffersFromKnowledge(): void {
    const KNOWLEDGE_PATH = "./lib/knowledge/offers.txt";
    let knowledgeBase = "";
    
    try {
        knowledgeBase = fs.readFileSync(KNOWLEDGE_PATH, "utf-8");
        console.log("📚 Loaded offers from", KNOWLEDGE_PATH);
    } catch (err) {
        console.warn("⚠️ Could not load offers:", err);
        return;
    }

    const offers: Offer[] = [];
    const lines = knowledgeBase.split('\n');
    
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || trimmed.toUpperCase() === trimmed) continue;
        
        // Parse format: "Brand/Name – Description (optional URL)"
        const match = trimmed.match(/^(.+?)\s*–\s*(.+?)(?:\s+(https?:\/\/\S+))?\s*\.?\s*$/);
        if (match) {
            const [, name, description, url] = match;
            
            offers.push({
                name: name.trim(),
                description: description.trim(),
                url: url || '',
                category: categorizeOffer(name, description),
                keywords: extractKeywords(name + ' ' + description),
                value: calculateOfferValue(name, description),
                urgency: detectUrgency(description)
            });
        }
    }
    
    offerDatabase = offers;
    console.log(`📊 Parsed ${offers.length} offers from knowledge base`);
}

// ============================================================================
// OFFER ANALYSIS
// ============================================================================
function categorizeOffer(name: string, description: string): string {
    const text = (name + ' ' + description).toLowerCase();
    
    const categories = {
        'trading': ['trading', 'crypto', 'bitcoin', 'signals', 'options', 'investment'],
        'business': ['agency', 'business', 'coaching', 'mentor', 'entrepreneur'],
        'gambling': ['betting', 'casino', 'picks', 'sportsbook', 'gambling'],
        'content': ['tiktok', 'content', 'copywriting', 'social', 'viral'],
        'tech': ['python', 'coding', 'ai', 'automation', 'tech'],
        'food': ['food', 'pizza', 'delivery', 'restaurant', 'eats'],
        'fashion': ['shoes', 'clothes', 'fashion', 'apparel'],
        'entertainment': ['streaming', 'music', 'entertainment', 'netflix', 'spotify'],
        'travel': ['travel', 'airbnb', 'flights', 'hotel']
    };
    
    for (const [category, keywords] of Object.entries(categories)) {
        if (keywords.some(keyword => text.includes(keyword))) {
            return category;
        }
    }
    
    return 'general';
}

function extractKeywords(text: string): string[] {
    const words = text.toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .split(/\s+/)
        .filter(word => word.length > 2)
        .filter(word => !['the', 'and', 'for', 'with', 'get', 'off', 'all', 'any', 'new'].includes(word));
    
    return [...new Set(words)].slice(0, 8);
}

function calculateOfferValue(name: string, description: string): number {
    const text = (name + ' ' + description).toLowerCase();
    let value = 5; // Base value
    
    // Discount indicators
    if (/free|50%|40%|30%/.test(text)) value += 3;
    if (/25%|20%|15%/.test(text)) value += 2;
    if (/10%|5%/.test(text)) value += 1;
    
    // Brand recognition
    if (/nike|adidas|starbucks|amazon|netflix|spotify|uber/.test(text)) value += 2;
    
    // Urgency indicators
    if (/today|limited|flash|ends soon/.test(text)) value += 1;
    
    return Math.min(value, 10);
}

function detectUrgency(description: string): 'low' | 'medium' | 'high' {
    const text = description.toLowerCase();
    
    if (/today only|flash|ends soon|limited time|expires/.test(text)) return 'high';
    if (/this week|weekend|sunday|friday/.test(text)) return 'medium';
    
    return 'low';
}

// ============================================================================
// MESSAGE ANALYSIS
// ============================================================================
export async function analyzeMessage(message: string, userId: string): Promise<MessageAnalysis> {
    const lowerMessage = message.toLowerCase();
    
    // Intent detection
    let intent: MessageAnalysis['intent'] = 'not_relevant';
    let confidence = 0;
    
    // Direct deal seeking
    const dealSeeking = [
        'any deals', 'any offers', 'any promos', 'any discounts',
        'looking for deals', 'need a deal', 'find a deal',
        'best price', 'cheapest', 'save money', 'good deal'
    ];
    
    if (dealSeeking.some(phrase => lowerMessage.includes(phrase))) {
        intent = 'seeking_deal';
        confidence = 0.9;
    }
    
    // Questions
    const questionIndicators = [
        'recommend', 'suggestion', 'advice', 'what should', 'which is better',
        'anyone know', 'does anyone', 'has anyone tried'
    ];
    
    if (questionIndicators.some(phrase => lowerMessage.includes(phrase)) || lowerMessage.includes('?')) {
        intent = 'asking_question';
        confidence = Math.max(confidence, 0.7);
    }
    
    // General interest
    const interestIndicators = [
        'thinking about', 'considering', 'might try', 'heard about',
        'want to', 'need to', 'looking to', 'trying to'
    ];
    
    if (interestIndicators.some(phrase => lowerMessage.includes(phrase))) {
        intent = 'general_interest';
        confidence = Math.max(confidence, 0.5);
    }
    
    // Category and brand detection
    const category = detectMessageCategory(lowerMessage);
    const specificBrands = detectMentionedBrands(lowerMessage);
    const urgencyLevel = detectMessageUrgency(lowerMessage);
    
    // Should respond logic
    const shouldRespond = (
        confidence >= 0.5 && 
        intent !== 'not_relevant' &&
        (category !== 'general' || specificBrands.length > 0)
    );
    
    return {
        intent,
        category,
        confidence,
        shouldRespond,
        specificBrands,
        urgencyLevel
    };
}

function detectMessageCategory(message: string): string {
    const categories = {
        'trading': ['trading', 'crypto', 'bitcoin', 'investing', 'stocks', 'options', 'signals'],
        'food': ['food', 'pizza', 'delivery', 'restaurant', 'eating', 'hungry', 'order'],
        'fashion': ['shoes', 'clothes', 'shirt', 'pants', 'dress', 'nike', 'adidas'],
        'entertainment': ['movie', 'music', 'streaming', 'netflix', 'spotify', 'show'],
        'travel': ['travel', 'trip', 'vacation', 'flight', 'hotel', 'airbnb'],
        'gambling': ['bet', 'betting', 'casino', 'picks', 'odds', 'gambling'],
        'business': ['business', 'agency', 'coaching', 'mentor', 'entrepreneur'],
        'tech': ['coding', 'python', 'ai', 'automation', 'tech', 'programming']
    };
    
    for (const [category, keywords] of Object.entries(categories)) {
        if (keywords.some(keyword => message.includes(keyword))) {
            return category;
        }
    }
    
    return 'general';
}

function detectMentionedBrands(message: string): string[] {
    const brands = [
        'nike', 'adidas', 'starbucks', 'dominos', 'amazon', 'uber', 'netflix',
        'spotify', 'airbnb', 'doordash', 'grubhub', 'apple', 'samsung'
    ];
    
    return brands.filter(brand => message.includes(brand));
}

function detectMessageUrgency(message: string): 'low' | 'medium' | 'high' {
    if (/asap|urgent|now|today|quickly/.test(message)) return 'high';
    if (/soon|this week|weekend/.test(message)) return 'medium';
    return 'low';
}

// ============================================================================
// OFFER MATCHING
// ============================================================================
export function findBestOffer(
    message: string, 
    analysis: MessageAnalysis, 
    userId: string
): OfferMatch | null {
    if (offerDatabase.length === 0) return null;
    
    let candidates: OfferMatch[] = [];
    
    for (const offer of offerDatabase) {
        let relevanceScore = 0;
        let reasoning = '';
        
        // Category match bonus
        if (offer.category === analysis.category) {
            relevanceScore += 4;
            reasoning += `Category match (${analysis.category}). `;
        }
        
        // Keyword matching
        const messageWords = message.toLowerCase().split(/\s+/);
        const keywordMatches = offer.keywords.filter(keyword => 
            messageWords.some(word => word.includes(keyword) || keyword.includes(word))
        );
        relevanceScore += keywordMatches.length * 2;
        if (keywordMatches.length > 0) {
            reasoning += `Keywords: ${keywordMatches.join(', ')}. `;
        }
        
        // Brand mention bonus
        if (analysis.specificBrands.some(brand => 
            offer.name.toLowerCase().includes(brand) || 
            offer.description.toLowerCase().includes(brand)
        )) {
            relevanceScore += 5;
            reasoning += 'Brand mentioned. ';
        }
        
        // Value and urgency bonus
        relevanceScore += offer.value * 0.3;
        if (offer.urgency === 'high' && analysis.urgencyLevel === 'high') {
            relevanceScore += 2;
            reasoning += 'Urgency match. ';
        }
        
        // Intent bonus
        if (analysis.intent === 'seeking_deal') {
            relevanceScore += 2;
        }
        
        if (relevanceScore >= 3) { // Minimum threshold
            candidates.push({
                offer: offer.name,
                relevanceScore,
                category: offer.category,
                reasoning: reasoning.trim()
            });
        }
    }
    
    // Sort by relevance and return best match
    candidates.sort((a, b) => b.relevanceScore - a.relevanceScore);
    return candidates[0] || null;
}

// ============================================================================
// RESPONSE GENERATION
// ============================================================================
export async function generateNaturalResponse(
    offerMatch: OfferMatch, 
    originalMessage: string, 
    context: { feedId: string; userId: string; userName?: string; isGroupChat: boolean }
): Promise<string | null> {
    const offer = offerDatabase.find(o => o.name === offerMatch.offer);
    if (!offer) return null;
    
    try {
        const prompt = `Generate a brief, natural response recommending this offer:

OFFER: ${offer.name} – ${offer.description}${offer.url ? ` (${offer.url})` : ''}
USER MESSAGE: "${originalMessage}"
CONTEXT: User is interested in ${offerMatch.category}, relevance score: ${offerMatch.relevanceScore}

Guidelines:
- Be conversational and natural (like a helpful group member)
- Start with a natural lead-in based on their message
- Keep it under 40 words
- Include the offer name, key benefit, and URL if available
- Don't sound like a sales pitch

Example formats:
"Sounds like you're looking for X. Here's a great deal: [offer] – [benefit] ([url])"
"Perfect timing! [offer] has [benefit] right now: [url]"
"You might like this: [offer] – [description] ([url])"`;

        const response = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
            },
            body: JSON.stringify({
                model: "gpt-4",
                messages: [{ role: "user", content: prompt }],
                max_tokens: 80,
                temperature: 0.7,
            }),
        });

        const data = await response.json() as any;
        return data.choices?.[0]?.message?.content?.trim() || null;
    } catch (error) {
        console.error("Error generating response:", error);
        
        // Fallback to template response
        const templates = [
            `Here's a deal you might like: ${offer.name} – ${offer.description}${offer.url ? ` (${offer.url})` : ''}`,
            `Perfect timing! ${offer.name} has ${offer.description}${offer.url ? ` ${offer.url}` : ''}`,
            `You might find this helpful: ${offer.name} – ${offer.description}${offer.url ? ` (${offer.url})` : ''}`
        ];
        
        return templates[Math.floor(Math.random() * templates.length)];
    }
} 