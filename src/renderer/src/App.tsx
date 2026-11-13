import { useEffect, type ReactNode } from 'react'
import { AppearanceSetting } from '@core/stores/AppearanceSetting'
import { defaultsEnum } from '@core/support/Defaults'
import { DashboardView } from './screens/DashboardView'
import { StoresProvider, useStores } from './state/context'
import { TrayIconUpdater } from './tray/TrayIconUpdater'

function Theme({ children }: { children: ReactNode }): ReactNode {
  const stores = useStores()
  const setting = defaultsEnum(stores.defaults, AppearanceSetting.key, AppearanceSetting.allCases, 'system')
  const dark = setting === 'system' ? stores.state.systemDark : setting === 'dark'
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    document.documentElement.dataset.reduceMotion = String(stores.state.reduceMotion)
  }, [dark, stores.state.reduceMotion])
  return children
}

export function App(): ReactNode {
  return (
    <StoresProvider>
      <TrayIconUpdater />
      <Theme>
        <DashboardView />
      </Theme>
    </StoresProvider>
  )
}
