import React from 'react';
import type { IconProps } from '../types';

export function ShareSolidIcon({ size = 24, color = 'currentColor', className, style }: IconProps): React.ReactElement {
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
      <path d="M9 18H15V12H20V14H22V20H20V22H4V20H2V14H4V12H9V18ZM13 4H15V6H17V8H13V16H11V8H7V6H9V4H11V2H13V4Z"/>
    </svg>
  );
}
