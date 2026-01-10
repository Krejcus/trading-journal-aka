import React, { useState, useRef, useEffect } from 'react';
import { Send, Bot, Loader2 } from 'lucide-react';
import { ChatMessage, TradeStats, Trade } from '../types';
import { GeminiService } from '../services/geminiService';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface MentorChatProps {
  stats: TradeStats;
  badExits: Trade[];
  theme: 'dark' | 'light';
}

const MentorChat: React.FC<MentorChatProps> = ({ stats, badExits, theme }) => {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'init',
      role: 'assistant',
      content: 'Jsem **AlphaTrade Mentor**. Nahrál jsi svá data. Vidím všechna čísla. Na co se chceš zeptat? Můžu provést kompletní audit ("Analyzuj to"), najít chyby v exekuci nebo zhodnotit konkrétní signály.',
      timestamp: Date.now()
    }
  ]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const geminiRef = useRef<GeminiService>(new GeminiService());
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSend = async () => {
    if (!input.trim() || isLoading) return;

    const userMsg: ChatMessage = {
      id: Date.now().toString(),
      role: 'user',
      content: input,
      timestamp: Date.now()
    };

    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setIsLoading(true);

    const responseText = await geminiRef.current.analyzePerformance(stats, badExits, userMsg.content);

    const aiMsg: ChatMessage = {
      id: (Date.now() + 1).toString(),
      role: 'assistant',
      content: responseText,
      timestamp: Date.now()
    };

    setMessages(prev => [...prev, aiMsg]);
    setIsLoading(false);
  };

  return (
    <div className={`rounded-xl border flex flex-col h-[600px] transition-colors ${
      theme === 'dark' 
        ? 'bg-[#1E293B] border-slate-700/50' 
        : 'bg-white border-slate-200 shadow-sm'
    }`}>
      <div className={`p-4 border-b rounded-t-xl flex items-center gap-3 ${
        theme === 'dark' ? 'border-slate-800 bg-[#0F172A]/30' : 'border-slate-100 bg-slate-50'
      }`}>
        <div className="w-10 h-10 rounded-full bg-blue-600 flex items-center justify-center shadow-lg shadow-blue-500/20">
          <Bot className="text-white" />
        </div>
        <div>
          <h3 className={`font-bold ${theme === 'dark' ? 'text-white' : 'text-slate-900'}`}>AlphaTrade Mentor AI</h3>
          <p className="text-xs text-emerald-500 flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
            Online & Analyzuje
          </p>
        </div>
      </div>

      <div className={`flex-1 overflow-y-auto p-4 space-y-4 ${theme === 'dark' ? 'bg-[#1E293B]' : 'bg-white'}`} ref={scrollRef}>
        {messages.map((msg) => (
          <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div 
              className={`max-w-[85%] rounded-2xl p-4 shadow-sm ${
                msg.role === 'user' 
                  ? 'bg-blue-600 text-white rounded-br-none' 
                  : (theme === 'dark' 
                      ? 'bg-slate-800 text-slate-200 border border-slate-700' 
                      : 'bg-slate-100 text-slate-800 border border-slate-200') + ' rounded-bl-none'
              }`}
            >
              <div className="prose prose-sm max-w-none prose-p:leading-relaxed">
                 <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
              </div>
            </div>
          </div>
        ))}
        {isLoading && (
          <div className="flex justify-start">
             <div className={`p-4 rounded-2xl rounded-bl-none border flex items-center gap-2 ${
               theme === 'dark' 
                ? 'bg-slate-800 text-slate-400 border-slate-700' 
                : 'bg-slate-50 text-slate-500 border-slate-200'
             }`}>
                <Loader2 className="animate-spin w-4 h-4" />
                <span>Analyzuji grafy a data...</span>
             </div>
          </div>
        )}
      </div>

      <div className={`p-4 border-t rounded-b-xl ${
        theme === 'dark' ? 'border-slate-800 bg-[#0F172A]/30' : 'border-slate-100 bg-slate-50'
      }`}>
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSend()}
            placeholder="Napiš 'Analyzuj to' nebo 'Kde dělám chybu?'..."
            className={`flex-1 border rounded-lg px-4 py-3 focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-colors ${
              theme === 'dark' 
                ? 'bg-slate-900 border-slate-700 text-white placeholder-slate-500' 
                : 'bg-white border-slate-200 text-slate-900 placeholder-slate-400'
            }`}
          />
          <button 
            onClick={handleSend}
            disabled={isLoading || !input.trim()}
            className="bg-blue-600 hover:bg-blue-700 text-white p-3 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-lg shadow-blue-500/20"
          >
            <Send size={20} />
          </button>
        </div>
        <div className="flex gap-2 mt-3">
          {['Analyzuj to', 'Najdi chyby', 'Jaký mám Win Rate?'].map(cmd => (
            <button 
              key={cmd} 
              onClick={() => { setInput(cmd); }}
              className={`text-xs px-3 py-1 rounded-full border transition-colors ${
                theme === 'dark' 
                  ? 'bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white border-slate-700' 
                  : 'bg-white hover:bg-slate-100 text-slate-500 hover:text-slate-900 border-slate-200'
              }`}
            >
              {cmd}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

export default MentorChat;