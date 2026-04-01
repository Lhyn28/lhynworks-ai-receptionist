import fetch from 'node-fetch';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const data = req.body;
    console.log("📥 Incoming webhook payload:", JSON.stringify(data));
    
    // 🔥 FIX: Mapping strictly to your GHL execution logs payload
    const customerMessage = data.customData?.message || data.message?.body || data.message || "Hello";
    const contactId = data.customData?.id || data.contact_id || data.id;

    // Strict validation
    if (!contactId) {
      console.log("⚠️ Missing contact ID in payload.");
      return res.status(400).json({ error: 'Missing contact id from GHL' });
    }

    // 1. Requesting OpenRouter
    const openRouterResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://lhynworks.com', 
        'X-Title': 'Lhynworks AI Receptionist'
      },
      body: JSON.stringify({
        model: 'openrouter/auto', 
        messages: [
          {
            role: 'system',
            content: `You are Lhyn's AI double representing Lhynworks. You are incredibly polite, warm, and human. 
            Follow this strict sequence of rules:
            1. Greet the user with: "Hi! Good morning! How are you? I'm Lhyn, may I know your name?"
            2. After they give their name, politely ask for their email address: "Great to meet you! Can I get your email real quick? That way we can email you in case you ever need my services."
            3. Once you have both the name and email, use the 'upsertContact' function to save their data in GoHighLevel. After executing it, ask them how you can help them.
            4. Use the following knowledge base to answer questions about services and pricing:
               - About Lhyn: GoHighLevel Tech VA for Coaches & Agencies.
               - Services: Funnels & Landing Pages, Tech Setup & DNS, Workflows & CRM Management.
               - Pricing: Custom services generally start at around $250 for smaller setups and up to $1,000+ for full account overhauls. Give ballpark estimates and suggest a call.
            5. If they agree to book a call, use the 'bookAndAlert' function to book the call.
            6. If they say "Thank you", politely say "You're welcome!", summarize, and say goodbye.`
          },
          { role: 'user', content: customerMessage }
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "upsertContact",
              description: "Saves the guest's name and email in GHL.",
              parameters: {
                type: "object",
                properties: {
                  firstName: { type: "string" },
                  email: { type: "string" }
                },
                required: ["email", "firstName"]
              }
            }
          },
          {
            type: "function",
            function: {
              name: "bookAndAlert",
              description: "Saves their specific problem and books them on the calendar.",
              parameters: {
                type: "object",
                properties: {
                  clientProblem: { type: "string", description: "A quick summary of what the client needs help with." },
                  startTime: { type: "string", description: "ISO 8601 format date time for the appointment." }
                },
                required: ["clientProblem", "startTime"]
              }
            }
          }
        ]
      })
    });

    const aiData = await openRouterResponse.json();
    
    if (aiData.error) {
      console.error("🚨 OpenRouter API Error Details:", aiData.error);
      throw new Error(`OpenRouter Error: ${aiData.error.message || JSON.stringify(aiData.error)}`);
    }

    if (!aiData.choices || aiData.choices.length === 0) {
      console.error("🚨 OpenRouter returned no choices. Full response:", JSON.stringify(aiData));
      throw new Error("OpenRouter did not return valid completion data.");
    }
    
    const responseMessage = aiData.choices[0].message;

    // 2. Executing Function Calls (GHL Automations)
    if (responseMessage.tool_calls) {
      const toolCall = responseMessage.tool_calls[0];
      const args = JSON.parse(toolCall.function.arguments);

      if (toolCall.function.name === "upsertContact") {
        await fetch('https://services.leadconnectorhq.com/contacts/', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.GHL_API_KEY}`,
            'Content-Type': 'application/json',
            'Version': '2021-07-28'
          },
          body: JSON.stringify({
            locationId: process.env.GHL_LOCATION_ID,
            firstName: args.firstName,
            email: args.email
          })
        });

        return res.status(200).json({ success: true, reply: `Perfect, I've got you in the system, ${args.firstName}! How can I help you today?` });
      }

      if (toolCall.function.name === "bookAndAlert") {
        await fetch('https://services.leadconnectorhq.com/calendars/appointments', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.GHL_API_KEY}`,
            'Content-Type': 'application/json',
            'Version': '2021-07-28'
          },
          body: JSON.stringify({
            calendarId: process.env.GHL_CALENDAR_ID,
            contactId: contactId,
            startTime: args.startTime,
            title: `AI Chat - ${args.clientProblem}`
          })
        });

        await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}/tasks`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.GHL_API_KEY}`,
            'Content-Type': 'application/json',
            'Version': '2021-07-28'
          },
          body: JSON.stringify({
            title: `AI Alert: Needs help with ${args.clientProblem}`,
            body: `This client booked a call for ${args.startTime} and needs help with: ${args.clientProblem}`,
            dueDate: new Date().toISOString()
          })
        });

        return res.status(200).json({ success: true, reply: "Fantastic! You are all booked in. I've sent a summary of what you need to our team, and we will talk to you soon!" });
      }
    }

    const replyText = responseMessage.content || "Thanks for messaging! How can I help you today?";

    // 3. Normal conversation reply
    await fetch('https://services.leadconnectorhq.com/conversations/messages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GHL_API_KEY}`,
        'Content-Type': 'application/json',
        'Version': '2021-04-15'
      },
      body: JSON.stringify({
        type: 'Live_Chat',
        contactId: contactId,
        message: replyText
      })
    });

    return res.status(200).json({ success: true });

  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
}
