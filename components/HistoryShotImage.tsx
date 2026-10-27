import React, { useState } from 'react';
import { Image as ImageIcon } from 'lucide-react';
import { storageService } from '../services/storageService';

/**
 * Kostra náhledu: stejná plocha, ať se náhled teprve podepisuje (snímek
 * z kopírky), nebo stahuje. Obrázek ji pak plynule překryje — karta tak
 * neproblikne přes „Bez screenshotu“ ani přes skok skeleton → obrázek.
 */
export const HistoryShotSkeleton = ({ variant, hidden = false }: { variant: 'card' | 'row'; hidden?: boolean }) => (
  <div
    aria-hidden
    className={`history-shot-skeleton pointer-events-none absolute inset-0 z-10 flex items-center justify-center transition-opacity duration-300 ${hidden ? 'opacity-0' : 'opacity-100'}`}
  >
    <ImageIcon size={variant === 'card' ? 24 : 14} className="text-slate-500/40" />
  </div>
);

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
  // i předem dekódované náhledy (zahřátí Historie při startu) — bez kostry.
  const loaded = loadedHere || storageService.getLoadedImageIds().has(id);
  const handleLoad = () => {
    storageService.markImageLoaded(id); // persistent přes mount/unmount
    setLoadedHere(true);
  };
  if (variant === 'row') return (
    <>
      {!failed && <HistoryShotSkeleton variant="row" hidden={loaded} />}
      {failed ? (
        <ImageIcon size={14} className="text-slate-600" />
      ) : (
        <img
          src={src}
          alt=""
          onLoad={handleLoad}
          onError={() => onError(id)}
          loading="lazy"
          className={`w-full h-full object-cover ${copierThumb ? 'object-[80%_50%]' : ''} ${loaded ? 'opacity-60 scale-100' : 'opacity-0 scale-95'} group-hover:opacity-100 transition-[opacity,transform] duration-300`}
        />
      )}
    </>
  );
  return (
    <>
      {!failed && <HistoryShotSkeleton variant="card" hidden={loaded} />}
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
        className={`w-full h-full object-cover ${copierThumb ? 'object-[80%_50%]' : ''} ${loaded ? 'opacity-100' : 'opacity-0'} transition-[opacity,transform] duration-300 group-hover/img:scale-105`}
      />
    </>
  );
};
