import React from 'react';
import type { IconProps } from '../types';

// Authored in-house for the media crop affordance — the upstream pixel-art
// catalogue has no crop glyph, and `proportions-solid` reads as "aspect ratio"
// rather than "cut this image down". Visual cue: the two interlocking
// carpenter's arms of a classic crop tool, squared off to match the set's
// 2px-on-a-24-grid stroke.
export function CropIcon({ size = 24, color = 'currentColor', className, style }: IconProps): React.ReactElement {
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
      <path d="M6 2h2v16H6V2Z M6 16h16v2H6v-2Z M2 6h16v2H2V6Z M16 6h2v16h-2V6Z"/>
    </svg>
  );
}
