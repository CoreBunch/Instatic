import { AiBoxSolidIcon } from 'pixel-art-icons/icons/ai-box-solid'
import { ColorsSwatchSolidIcon } from 'pixel-art-icons/icons/colors-swatch-solid'
import { EditSolidIcon } from 'pixel-art-icons/icons/edit-solid'
import { EyeSolidIcon } from 'pixel-art-icons/icons/eye-solid'
import { UsersSolidIcon } from 'pixel-art-icons/icons/users-solid'
import styles from './ServiceAccounts.module.css'

const roles = new Map([
  ['designer', <ColorsSwatchSolidIcon size={18} />],
  ['writer', <EditSolidIcon size={18} />],
  ['reviewer', <EyeSolidIcon size={18} />],
])

export function CliIdentityIcon(props: { agent: string } | { group: true }) {
  if ('group' in props) {
    return <span className={styles.tile} aria-hidden="true"><UsersSolidIcon size={18} /></span>
  }
  const role = props.agent.trim().toLowerCase().split(/\s+/).pop() ?? ''
  return <span className={styles.tile} data-role={role} aria-hidden="true">{roles.get(role) ?? <AiBoxSolidIcon size={18} />}</span>
}
