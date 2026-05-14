import React from 'react';
import { Bot } from 'lucide-react';

interface Props {
  onNavigateToAI: () => void;
  hasConversations?: boolean;
}

const AIChat: React.FC<Props> = ({ onNavigateToAI, hasConversations }) => {
  return (
    <button
      onClick={onNavigateToAI}
      className="fixed bottom-6 right-6 z-50 w-14 h-14 rounded-full bg-blue-600 hover:bg-blue-500 text-white shadow-2xl shadow-blue-500/30 flex items-center justify-center transition-all duration-300 hover:scale-110 active:scale-95"
      title="AI Coach"
    >
      <Bot size={22} />
      {hasConversations && (
        <span className="absolute top-1 right-1 w-2.5 h-2.5 rounded-full bg-emerald-400 border-2 border-[#0d0d12]" />
      )}
    </button>
  );
};

export default AIChat;
