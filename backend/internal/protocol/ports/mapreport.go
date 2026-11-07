package ports

import "github.com/868-no/map/internal/protocol/pb"

// MapReport is a node's own periodic MQTT report about itself (topic
// .../2/map/, MAP_REPORT_APP). Only the reporting node publishes it, so it
// is never relayed RF traffic. Its location, when present, is a reported
// position with the node's chosen precision.
type MapReport struct {
	LongName          string `json:"long_name,omitempty"`
	ShortName         string `json:"short_name,omitempty"`
	Role              string `json:"role,omitempty"`
	HwModel           string `json:"hw_model,omitempty"`
	FirmwareVersion   string `json:"firmware_version,omitempty"`
	Region            string `json:"region,omitempty"`
	ModemPreset       string `json:"modem_preset,omitempty"`
	HasDefaultChannel bool   `json:"has_default_channel,omitempty"`
	OnlineLocalNodes  uint32 `json:"online_local_nodes,omitempty"`
	OptedLocation     bool   `json:"opted_report_location,omitempty"`
}

// decodeMapReport returns the report and, when it carries usable
// coordinates, a Position built the same way as a POSITION_APP packet.
func decodeMapReport(b []byte) (*MapReport, *Position, error) {
	var m pb.MapReport
	if err := decode(b, &m); err != nil {
		return nil, nil, ErrInvalid
	}
	r := &MapReport{
		LongName: CleanString(m.GetLongName(), 40), ShortName: CleanString(m.GetShortName(), 8),
		Role: m.GetRole().String(), HwModel: m.GetHwModel().String(), FirmwareVersion: CleanString(m.GetFirmwareVersion(), 32),
		Region: m.GetRegion().String(), ModemPreset: m.GetModemPreset().String(), HasDefaultChannel: m.GetHasDefaultChannel(),
		OnlineLocalNodes: m.GetNumOnlineLocalNodes(), OptedLocation: m.GetHasOptedReportLocation(),
	}
	if m.GetLatitudeI() == 0 && m.GetLongitudeI() == 0 {
		return r, nil, nil
	}
	lat, lon := float64(m.GetLatitudeI())*1e-7, float64(m.GetLongitudeI())*1e-7
	if lat < -90 || lat > 90 || lon < -180 || lon > 180 || m.GetPositionPrecision() > 32 {
		return nil, nil, ErrInvalid
	}
	p := &Position{Lat: lat, Lon: lon, PrecisionBits: m.GetPositionPrecision(), PrecisionKnown: m.GetPositionPrecision() > 0}
	if a := m.GetAltitude(); a > -500 && a < 12000 && a != 0 {
		p.Alt = &a
	}
	return r, p, nil
}
