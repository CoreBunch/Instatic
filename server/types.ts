export interface SiteRow {
  id: string
  name: string
  settings_json: Record<string, unknown>
  created_at: Date | string
  updated_at: Date | string
}

export type UserStatus = 'active' | 'suspended'
type UserStepUpAuthMode = 'required' | 'disabled'

export interface RoleRow {
  id: string
  slug: string
  name: string
  description: string
  is_system: boolean | number
  capabilities_json: unknown
  created_at: Date | string
  updated_at: Date | string
}

export interface UserRow {
  id: string
  email: string
  email_normalized: string
  display_name: string
  password_hash: string
  status: UserStatus
  role_id: string
  last_login_at: Date | string | null
  failed_login_count: number
  locked_until: Date | string | null
  avatar_media_id: string | null
  password_updated_at: Date | string | null
  mfa_enabled: boolean | number
  mfa_enabled_at: Date | string | null
  mfa_totp_secret_ciphertext: Uint8Array | null
  mfa_totp_secret_iv: Uint8Array | null
  mfa_totp_secret_key_fingerprint: string | null
  mfa_recovery_code_hashes_json: unknown
  step_up_auth_mode: UserStepUpAuthMode | string
  step_up_window_minutes: number
  created_at: Date | string
  updated_at: Date | string
  deleted_at: Date | string | null
}
