import React from 'react';
import type { IconProps } from '../types';

export function GitBranchSolidIcon({ size = 24, color = 'currentColor', className, style }: IconProps): React.ReactElement {
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
      <path d="M8 16h2v4H8v2H4v-2H2v-4h2v-2h4v2Zm9 3h-5v-2h5v2Zm2-2h-2v-5h2v5ZM7 12H5V2h2v10Zm13-8h2v4h-2v2h-4V8h-2V4h2V2h4v2Z"/>
    </svg>
  );
}
