import { GoogleGenAI } from '@google/genai';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

async function test() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.log("No GEMINI_API_KEY found");
    return;
  }
  const ai = new GoogleGenAI({ apiKey });
  console.log("Testing Gemini API...");
  try {
    const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: "Ahoj, jsi tam?"
    });
    console.log("Success! Response:", response.text);
  } catch (e: any) {
    console.error("Error from Google Gemini:", e.status, e.message || e);
  }
}
test();
