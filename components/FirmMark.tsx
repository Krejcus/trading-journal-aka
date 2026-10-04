import React from 'react';
import { firmColor, firmInitials } from '../utils/accountFirm';
import { OTHER_FIRM, firmDisplayName, firmLogo } from '../lib/businessFirms';

/** Logo prop firmy (nebo barevný monogram, když logo nemáme). */
export default function FirmMark({ firm, size = 20, className = '' }: { firm: string; size?: number; className?: string }) {
  const logo = firmLogo(firm);
  const label = firmDisplayName(firm);
  const style = { width: size, height: size, borderRadius: Math.round(size / 4) };
  if (logo) {
    return <img src={logo} alt={label} title={label} style={style} className={`shrink-0 bg-white object-contain p-[2px] ${className}`} />;
  }
  const color = firm === OTHER_FIRM ? { bg: '#94a3b8', fg: '#fff' } : firmColor(label);
  return (
    <span title={label} style={{ ...style, background: color.bg, color: color.fg, fontSize: Math.max(8, Math.round(size * 0.42)) }}
      className={`inline-grid shrink-0 place-items-center font-extrabold leading-none ${className}`}>
      {firmInitials(label)}
    </span>
  );
}
