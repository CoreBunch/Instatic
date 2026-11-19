import React from 'react';
import type { IconProps } from '../types';

export function MailSolidIcon({ size = 24, color = 'currentColor', className, style }: IconProps): React.ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={color}
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={style}
    >
      <path d="M20 20H4v-2H2V6h2V4h16v2h2v12h-2v2Zm-10-6h4v-2h-4v2Zm-2-2h2v-2H8v2Zm6 0h2v-2h-2v2Zm-8-2h2V8H6v2Zm10 0h2V8h-2v2Z"/>
    </svg>
  );
}
