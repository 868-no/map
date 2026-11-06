import type { NodeView, Radio } from '../../derive/views'
import { formatLocal } from '../../lib/time'
import { NR } from './shared'

/** "NARROW_FAST" -> "Narrow Fast" */
const presetName = (p: string) => p.toLowerCase().split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ')

/**
 * Region and LoRa preset. Region: the node's own map report if any, else
 * what its topics allow. Preset: the engine's inference (D-064), strongest
 * evidence first; a map report's preset counts only when confirmed.
 */
function radioSummary(r: Radio | undefined, name: (id: string) => string): { region: string; preset: string; presetNote: string } {
  const heard = r?.heard_as ?? []
  let region = 'unknown'
  if (r?.reported?.region) region = `${r.reported.region} (its own map report)`
  else {
    // One node has one region: keep only regions every topic it was heard on allows.
    const sets = heard.filter((h) => h.regions.length).map((h) => h.regions)
    if (sets.length) {
      const common = sets.reduce((acc, r) => acc.filter((x) => r.includes(x)))
      region = common.length
        ? `${common.join(' or ')} (from the MQTT topic${sets.length > 1 ? 's' : ''})`
        : `conflicting topics: ${[...new Set(sets.map((r) => r.join(' or ')))].join(' / ')}`
    }
  }
  const p = r?.preset
  const via = (p?.via ?? []).map(name).join(', ')
  const others = (n: number) => `${n} other node${n === 1 ? '' : 's'}`
  let preset = 'unknown'
  let presetNote = 'No evidence in the selected period: no confirmed map report, no default channel name, and no radio contact with a node that has either.'
  if (p?.basis === 'conflict') {
    preset = `conflicting: ${(p.conflict ?? []).map(([q, n]) => `${presetName(q)} (${n})`).join(', ')}`
    presetNote = 'Nodes it shares radio contact with report different confirmed presets. Nodes that hear each other must share radio settings, so one of the links or reports is misleading (for example a downlinked packet that looked like a direct reception).'
  } else if (p?.preset) {
    const q = presetName(p.preset)
    if (p.basis === 'map_report') {
      preset = `${q} (its own map report)`
      presetNote = 'Its own map report, confirmed by its default channel: firmware reports a preset as in use only then.'
    } else if (p.basis === 'radio_contact') {
      preset = `${q} (radio contact)`
      presetNote = `Nodes that hear each other must share radio settings. It heard or was heard by ${others(p.direct)} itself, and through them and their contacts it is in radio contact with ${others(p.group)} in all; confirmed map reports from ${via} in that group put it on ${q} (or identical custom settings).`
    } else if (p.basis === 'channel_name') {
      preset = `probably ${q} (channel name)`
      presetNote = `It was heard on a channel with ${q}'s default name. Only a hint: a secondary channel can carry that name on any preset.`
    } else {
      preset = `probably ${q} (radio contact, channel names)`
      presetNote = `It heard or was heard by ${others(p.direct)} itself, and through chains of radio contact shares radio settings with ${others(p.group)} in all, among them ${via}, heard on channels with ${q}'s default name. Only a hint: no confirmed map report in the group.`
    }
  }
  const rep = r?.reported
  // Firmware reports its stored preset even under a custom modem config.
  if (rep?.modem_preset && !rep.preset_confirmed) presetNote += ` Its map report says ${presetName(rep.modem_preset)}, but without a default channel that may be a stored preset under a custom modem config.`
  return { region, preset, presetNote }
}

/** The Radio tab: region, preset, channels, MQTT topics and brokers. */
export function RadioTab({ d, names }: { d: NodeView; names: ReadonlyMap<string, string> }) {
  const radio = radioSummary(d.radio, (n) => names.get(n) ?? n)
  return (
    <>
      <dl>
        <dt>Region</dt><dd>{radio.region}</dd>
        <dt>LoRa preset</dt><dd title={radio.presetNote}>{radio.preset}</dd>
        <dt>Channels</dt>
        <dd>
          {d.radio?.channels?.length
            ? d.radio.channels.map((c, k) => (
                <span key={c.name} title={[c.primary && 'Its primary channel (its own map report).', c.sent && `${c.sent} of its packets uplinked on it.`, c.uplinked && `Uplinked ${c.uplinked} receptions on it as a gateway.`].filter(Boolean).join(' ')}>
                  {k > 0 && ', '}{c.name}{c.primary && ' (primary)'}
                </span>
              ))
            : NR}
        </dd>
        <dt>Brokers</dt><dd>{d.brokers?.length ? d.brokers.join(', ') : NR}</dd>
        {d.is_gateway && (
          <>
            <dt title="The topic root this gateway publishes under, from the topics of the packets it uplinked in the selected period">MQTT root topic</dt>
            <dd>
              {!d.radio.uplink_topics?.length
                ? NR
                : d.radio.uplink_topics.map((t, k) => (
                    <div key={t.topic} title={`Regions: ${t.regions.join(' or ') || 'unknown'} · last ${formatLocal(t.last_at)}`}>
                      <code className="topic">{t.topic}</code>
                      {d.radio.uplink_topics!.length > 1 && <small className="muted"> · {t.receptions} uplinks{k === 0 ? ' (most)' : ''}</small>}
                    </div>
                  ))}
            </dd>
          </>
        )}
      </dl>
      {(d.radio?.heard_as ?? []).length > 0 && (
        <>
          <h3 title="Each gateway uplinks with its own topic and channel name, so one node can be heard several ways">Heard on ({d.radio.heard_as.length})</h3>
          <table className="hear pkt-log" aria-label="Heard on">
            <colgroup><col /><col style={{ width: 90 }} /><col style={{ width: 88 }} /><col style={{ width: 34 }} /></colgroup>
            <thead><tr><th>MQTT topic</th><th>Channel</th><th>Preset</th><th>Rx</th></tr></thead>
            <tbody>
              {d.radio.heard_as.map((h) => (
                <tr key={h.topic + h.channel} title={`Regions: ${h.regions.join(' or ') || 'unknown'} · last ${formatLocal(h.last_at)}`}>
                  <td>{h.topic}</td><td>{h.channel ?? ''}</td><td>{h.preset ? presetName(h.preset) : 'unknown'}</td><td>{h.receptions}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  )
}
