import { useEffect, useRef, type ReactNode } from 'react'
import { DashboardTab } from '@core/models/DashboardTab'
import { MenuBarLimit } from '@core/models/MenuBarLimit'
import { PriorityLimits } from '@core/models/PriorityLimits'
import { ResetDisplayMode } from '@core/models/ResetDisplayMode'
import { WidgetDisplayMode } from '@core/models/WidgetDisplayMode'
import { AppearanceSetting } from '@core/stores/AppearanceSetting'
import { LogLevelSetting } from '@core/stores/LogLevelSetting'
import { TimeFormatSetting } from '@core/stores/TimeFormatSetting'
import { DisplaySettingKeys } from '@core/stores/WidgetDataStore'
import { defaultsBool, defaultsEnum } from '@core/support/Defaults'
import { PaceMilestone } from '@core/support/PaceNotificationLogic'
import { api } from '../../bridge'
import { Button, Picker, Spinner, Toggle } from '../../components/Controls'
import { Form, FormRow, FormSection } from '../../components/Form'
import { Icon } from '../../components/Icon'
import { Tooltip } from '../../components/Tooltip'
import { usePopover, useStores } from '../../state/context'
import { PriorityIconsPreview } from './PriorityIconsPreview'
import { ShortcutRecorder } from './ShortcutRecorder'
import './settings.css'

/** Saves one preference. The app answers with a new state, which redraws the control. */
function set(key: string, value: string | number | boolean): void {
  void api.setSetting(key, value)
}

function options<Value extends string>(cases: readonly Value[], label: (value: Value) => string): { value: Value; label: string }[] {
  return cases.map((value) => ({ value, label: label(value) }))
}

/** A row's title followed by an info icon that shows what the row does on hover. */
function Titled({ title, info }: { title: string; info: string }): ReactNode {
  return (
    <span className="settings-titled">
      <span>{title}</span>
      <Tooltip text={info}>
        <span className="settings-info" role="img" aria-label={info}>
          <Icon name="info.circle" size={11} />
        </span>
      </Tooltip>
    </span>
  )
}

/** A Priority limit row's label: its mark, then its title with what it does behind an info icon. */
function LimitLabel({ title, info, mark }: { title: string; info: string; mark: ReactNode }): ReactNode {
  return (
    <span className="settings-limit-label">
      <span className="settings-limit-mark">{mark}</span>
      <Titled title={title} info={info} />
    </span>
  )
}

function SeverityDot({ color }: { color: string }): ReactNode {
  return <span className="settings-severity-dot" style={{ background: color }} />
}

/** A footer line in the notice color (upstream's `SettingsNote`). */
function SettingsNote({ children }: { children: ReactNode }): ReactNode {
  return <div className="settings-note">{children}</div>
}

function Switch(props: { isOn: boolean; onChange: (isOn: boolean) => void; disabled?: boolean; label: string }): ReactNode {
  return <Toggle size="mini" isOn={props.isOn} onChange={props.onChange} disabled={props.disabled} label={props.label} />
}

function GeneralTab(): ReactNode {
  const { state, defaults } = useStores()
  const popover = usePopover()
  const defaultTab = DashboardTab.preferred(defaults)
  const notes = [state.launchAtLogin.errorMessage, state.shortcut.errorMessage].filter((note): note is string => note !== undefined && note !== '')
  return (
    <>
      <FormSection footer={notes.length > 0 ? notes.map((note) => <SettingsNote key={note}>{note}</SettingsNote>) : undefined}>
        <FormRow label="Launch at Login">
          <Switch label="Launch at Login" isOn={state.launchAtLogin.isEnabled} onChange={(enabled) => void api.setLaunchAtLogin(enabled)} />
        </FormRow>
        <FormRow label="Default Tab">
          <Picker
            label="Default Tab"
            value={defaultTab}
            options={options(DashboardTab.allCases, DashboardTab.label)}
            onChange={(tab) => {
              set(DashboardTab.defaultKey, tab)
              popover.dashboardTab = tab
            }}
          />
        </FormRow>
        <FormRow label="Global Shortcut">
          <ShortcutRecorder disabled={popover.screen !== 'settings'} />
        </FormRow>
      </FormSection>
      <UpdatesSection />
    </>
  )
}

function UpdatesSection(): ReactNode {
  const { updater } = useStores().state
  const isBusy = updater.status === 'checking' || updater.status === 'downloading'
  return (
    <FormSection header="Updates">
      <FormRow label="Check Automatically">
        <Switch
          label="Check Automatically"
          isOn={updater.automaticallyChecksForUpdates}
          disabled={!updater.isActive}
          onChange={(enabled) => void api.updaterSetAutomaticChecks(enabled)}
        />
      </FormRow>
      <FormRow label="Beta Updates">
        <Switch label="Beta Updates" isOn={updater.betaChannelEnabled} disabled={!updater.isActive} onChange={(enabled) => void api.updaterSetBetaChannel(enabled)} />
      </FormRow>
      <FormRow
        label={
          <span className="settings-update-status secondary">
            {isBusy ? <Spinner size={11} /> : null}
            {updater.message !== undefined ? <span>{updater.message}</span> : null}
          </span>
        }
      >
        <Button disabled={!updater.canCheckForUpdates} onClick={() => void api.updaterCheck()}>
          Check for Updates…
        </Button>
      </FormRow>
    </FormSection>
  )
}

function DisplayTab(): ReactNode {
  const { data, defaults } = useStores()
  const limits = data.priorityLimits
  const setLimits = (next: PriorityLimits): void => {
    set(DisplaySettingKeys.priorityWarning, next.warning)
    set(DisplaySettingKeys.priorityCritical, next.critical)
  }
  const levels = (values: readonly number[]): { value: number; label: string }[] => values.map((value) => ({ value, label: `${value}% left` }))
  const appearance = defaultsEnum(defaults, AppearanceSetting.key, AppearanceSetting.allCases, 'system')
  const timeFormat = defaultsEnum(defaults, TimeFormatSetting.key, TimeFormatSetting.allCases, 'auto')
  return (
    <>
      <FormSection header="Priority">
        <FormRow>
          <PriorityIconsPreview />
        </FormRow>
        <FormRow
          label={
            <Titled
              title="Max Items In Tray"
              info="The tray icon shows the limit closest to running out. Its tooltip lists up to this many; others show as a count, like +7."
            />
          }
        >
          <Picker
            label="Max Items In Tray"
            value={data.menuBarLimit}
            options={options(MenuBarLimit.allCases, MenuBarLimit.label)}
            onChange={(limit) => set(DisplaySettingKeys.menuBarLimit, limit)}
          />
        </FormRow>
        <FormRow label={<Titled title="Always Show In Tray" info="Show limits in the tray even if not requiring your attention yet" />}>
          <Switch
            label="Always Show In Tray"
            isOn={data.menuBarAlwaysShows}
            disabled={data.menuBarLimit === 'iconOnly'}
            onChange={(shows) => set(DisplaySettingKeys.menuBarAlwaysShows, shows)}
          />
        </FormRow>
      </FormSection>
      <FormSection>
        <FormRow label={<LimitLabel title="Warning" info="When a limit turns into a priority" mark={<SeverityDot color="var(--orange)" />} />}>
          <Picker
            label="Warning"
            value={limits.warning}
            options={levels(PriorityLimits.warningOptions)}
            onChange={(warning) => setLimits(PriorityLimits.settingWarning(limits, warning))}
          />
        </FormRow>
        <FormRow label={<LimitLabel title="Critical" info="When a limit turns critically low" mark={<SeverityDot color="var(--red)" />} />}>
          <Picker
            label="Critical"
            value={limits.critical}
            options={levels(PriorityLimits.criticalOptions)}
            onChange={(critical) => setLimits(PriorityLimits.settingCritical(limits, critical))}
          />
        </FormRow>
        <FormRow
          label={
            <LimitLabel
              title="Burning Fast"
              info="Will run out before it resets"
              mark={<Icon name="flame.fill" size={9} filled style={{ color: 'var(--orange)' }} />}
            />
          }
        >
          <Switch label="Burning Fast" isOn={data.showsBurningFast} onChange={(shows) => set(DisplaySettingKeys.priorityBurningFast, shows)} />
        </FormRow>
        <FormRow
          label={
            <LimitLabel
              title="Use It or Lose It"
              info={PaceMilestone.settingSubtitle(PaceMilestone.useItOrLoseIt)}
              mark={<Icon name="hourglass.tophalf.filled" size={9} weight="semibold" style={{ color: 'var(--blue)' }} />}
            />
          }
        >
          <Switch label="Use It or Lose It" isOn={data.showsUseItOrLoseIt} onChange={(shows) => set(DisplaySettingKeys.priorityUseItOrLoseIt, shows)} />
        </FormRow>
      </FormSection>
      <FormSection header="Appearance">
        <FormRow label="Theme">
          <Picker
            label="Theme"
            value={appearance}
            options={options(AppearanceSetting.allCases, AppearanceSetting.label)}
            onChange={(setting) => set(AppearanceSetting.key, setting)}
          />
        </FormRow>
        <FormRow label="Time Format">
          <Picker
            label="Time Format"
            value={timeFormat}
            options={options(TimeFormatSetting.allCases, TimeFormatSetting.label)}
            onChange={(setting) => set(TimeFormatSetting.key, setting)}
          />
        </FormRow>
      </FormSection>
      <FormSection header="Usage">
        <FormRow label="Show Usage As">
          <Picker
            label="Show Usage As"
            value={data.meterStyle}
            options={options(WidgetDisplayMode.allCases, WidgetDisplayMode.label)}
            onChange={(mode) => set(DisplaySettingKeys.meterStyle, mode)}
          />
        </FormRow>
        <FormRow label="Reset Times">
          <Picker
            label="Reset Times"
            value={data.resetDisplayMode}
            options={options(ResetDisplayMode.allCases, ResetDisplayMode.label)}
            onChange={(mode) => set(DisplaySettingKeys.resetDisplayMode, mode)}
          />
        </FormRow>
        <FormRow label={<Titled title="Pace Marks" info="Where usage would be at an even pace" />}>
          <Switch label="Pace Marks" isOn={data.showsPaceMarks} onChange={(shows) => set(DisplaySettingKeys.paceMarks, shows)} />
        </FormRow>
      </FormSection>
    </>
  )
}

/** In upstream's order: Critical, Warning, Will Run Out, Use It or Lose It. */
const alertMilestones: readonly PaceMilestone[] = [
  PaceMilestone.critical,
  PaceMilestone.warning,
  PaceMilestone.closeToRunningOut,
  PaceMilestone.useItOrLoseIt
]

function AlertsTab(): ReactNode {
  const { state, defaults } = useStores()
  const isOn = (milestone: PaceMilestone): boolean => defaultsBool(defaults, PaceMilestone.settingKey(milestone), false)
  // Windows asks for no permission, so there is no denied state to detect. With an alert on, the note
  // says where Windows can still silence it.
  const anyOn = alertMilestones.some(isOn)
  return (
    <FormSection
      header="Notifications"
      footer={
        anyOn ? (
          <div className="settings-footnote">
            Windows can turn alerts off for {state.app.name} in{' '}
            <button type="button" className="plain-button settings-link" onClick={() => void api.openNotificationSettings()}>
              Notification settings
            </button>
            .
          </div>
        ) : undefined
      }
    >
      {alertMilestones.map((milestone) => {
        const title = PaceMilestone.notificationTitle(milestone)
        return (
          <FormRow key={milestone} label={<Titled title={title} info={PaceMilestone.settingSubtitle(milestone)} />}>
            <Switch label={title} isOn={isOn(milestone)} onChange={(enabled) => set(PaceMilestone.settingKey(milestone), enabled)} />
          </FormRow>
        )
      })}
    </FormSection>
  )
}

function AdvancedTab(): ReactNode {
  const { state, defaults } = useStores()
  const { app, commandLine, demo } = state
  const logLevel = defaultsEnum(defaults, LogLevelSetting.key, LogLevelSetting.allCases, 'info')
  const commandLineNote =
    commandLine.errorMessage !== undefined && commandLine.errorMessage !== ''
      ? commandLine.errorMessage
      : commandLine.status === 'unavailable'
        ? `The ${app.commandName} command comes with the installed app.`
        : undefined
  return (
    <>
      {demo !== undefined ? (
        <FormSection header="Development">
          <FormRow label={<span className="mono-digits">Seed {String(demo.seed)}</span>}>
            <Button onClick={() => void api.demoReshuffle()}>Reshuffle</Button>
          </FormRow>
        </FormSection>
      ) : null}
      <FormSection header="Privacy">
        <FormRow
          label={
            <Titled
              title="Privacy Mode"
              info="Keep the panel out of screenshots and recordings, and usage off the tray icon"
            />
          }
        >
          <Switch label="Privacy Mode" isOn={state.privacyMode.isEnabled} onChange={(enabled) => void api.setPrivacyMode(enabled)} />
        </FormRow>
      </FormSection>
      <FormSection header="Command Line" footer={commandLineNote !== undefined ? <SettingsNote>{commandLineNote}</SettingsNote> : undefined}>
        <FormRow
          label={<Titled title="Terminal Helper" info={`Adds a global ${app.commandName} command that prints the usage the app last fetched. Open a new terminal after installing.`} />}
        >
          {commandLine.status === 'installed' ? (
            <Button onClick={() => void api.commandLineUninstall()}>Uninstall</Button>
          ) : commandLine.status === 'notInstalled' ? (
            <Button onClick={() => void api.commandLineInstall()}>Install…</Button>
          ) : (
            <span className="secondary">Unavailable</span>
          )}
        </FormRow>
      </FormSection>
      <FormSection header="Debug">
        <FormRow
          label={<Titled title="Log Level" info={`How much detail ${app.name} writes to its log. Choose Debug while you reproduce a problem.`} />}
        >
          <Picker
            label="Log Level"
            value={logLevel}
            options={options(LogLevelSetting.allCases, LogLevelSetting.label)}
            onChange={(level) => set(LogLevelSetting.key, level)}
          />
        </FormRow>
      </FormSection>
    </>
  )
}

/** Settings: four tabs of grouped rows (upstream's `SettingsScreen`). The tab bar is in the top bar. */
export function SettingsScreen(): ReactNode {
  const popover = usePopover()
  const root = useRef<HTMLDivElement>(null)
  const tab = popover.settingsTab
  const isShown = popover.screen === 'settings'

  // Each tab, and each visit, starts at the top.
  useEffect(() => {
    if (isShown) root.current?.closest('.panel-page-scroll')?.scrollTo({ top: 0 })
  }, [tab, isShown])

  return (
    <div ref={root} className="settings-form">
      <Form>{tab === 'general' ? <GeneralTab /> : tab === 'display' ? <DisplayTab /> : tab === 'alerts' ? <AlertsTab /> : <AdvancedTab />}</Form>
    </div>
  )
}
