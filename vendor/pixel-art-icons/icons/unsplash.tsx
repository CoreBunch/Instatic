import React from 'react';
import type { IconProps } from '../types';

// Authored in-house — the upstream pixel-art catalogue carries no brand marks.
// This is the Unsplash camera mark (a viewfinder block above a body with a
// matching notch), squared onto the set's 24 grid so it sits level with the
// other glyphs in a menu row.
export function UnsplashIcon({ size = 24, color = 'currentColor', className, style }: IconProps): React.ReactElement {
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
      <path d="M9 2h6v6H9V2Z M15 11h7v11H2V11h7v5h6v-5Z"/>
    </svg>
  );
}
