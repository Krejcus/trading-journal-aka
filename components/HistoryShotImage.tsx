import React, { useState } from 'react';
import { Image as ImageIcon } from 'lucide-react';
import { storageService } from '../services/storageService';

/**
 * Náhled screenshotu v kartě nebo řádku. Stav „načteno“ si drží sám: dřív
 * každé onLoad měnilo stav celé Historie a přerenderovalo všechny karty — při
 * scrollu desítky renderů po ~50 ms (dev, 170 karet). Teď se po načtení
 * překreslí jen tenhle náhled.
 */
export const HistoryShotImage = ({ id, src, failed, copierThumb, variant, onError }: {
  id: string;
  src: string;
  failed: boolean;
  copierThumb: boolean;
  variant: 'card' | 'row';
  onError: (id: string) => void;
}) => {
  const [loadedHere, setLoadedHere] = useState(false);
  // Globální set přežije remount karty (filtr, návrat na záložku) a obsahuje
  // i předem dekódované náhledy kopírky — bez problesknutí skeletonu.
  const loaded = loadedHere || storageService.getLoadedImageIds().has(id);
  const handleLoad = () => {
    storageService.markImageLoaded(id); // persistent přes mount/unmount
    setLoadedHere(true);
  };
  if (variant === 'row') return (
    <>
      {!loaded && !failed && (
        <div className="absolute inset-0 animate-pulse bg-slate-800/20 flex items-center justify-center z-10">
          <ImageIcon size={14} className="text-slate-700/50" />
        </div>
      )}
      {failed ? (
        <ImageIcon size={14} className="text-slate-600" />
      ) : (
        <img
          src={src}
          alt=""
          onLoad={handleLoad}
          onError={() => onError(id)}
          loading="lazy"
          className={`w-full h-full object-cover ${copierThumb ? 'object-[80%_50%] opacity-60 scale-100' : loaded ? 'opacity-60 scale-100' : 'opacity-0 scale-90'} group-hover:opacity-100 transition-transform duration-300`}
        />
      )}
    </>
  );
  return (
    <>
      {!loaded && !failed && (
        <div className="absolute inset-0 animate-pulse bg-slate-800/20 backdrop-blur-sm flex items-center justify-center z-10">
          <ImageIcon size={24} className="text-slate-700/50" />
        </div>
      )}
      {failed && (
        <div className="absolute inset-0 flex items-center justify-center bg-slate-900/60 z-10">
          <ImageIcon size={20} className="text-slate-600" />
        </div>
      )}

      <img
        src={src}
        alt=""
        onLoad={handleLoad}
        onError={() => onError(id)}
        loading="lazy"
        className={`w-full h-full object-cover ${copierThumb ? 'object-[80%_50%] opacity-100' : loaded ? 'opacity-100' : 'opacity-0'} transition-transform duration-300 group-hover/img:scale-105`}
      />
    </>
  );
};
