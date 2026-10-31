package protocol

import (
	"strings"
	"unicode/utf8"
)

// TopicKind classifies a Meshtastic MQTT topic.
type TopicKind uint8

const (
	TopicUnknown   TopicKind = iota
	TopicEncrypted           // {root}/2/e/{channel}/{gateway}: protobuf ServiceEnvelope (canonical v1 input)
	TopicLegacyC             // {root}/2/c/{channel}/{gateway}: pre-2.3 protobuf path
	TopicJSON                // {root}/2/json/...: counted, not processed in v1
	TopicMap                 // {root}/2/map/...: MapReport, a node's own plaintext report (D-032)
	TopicStat                // {root}/2/stat/{gateway}: gateway online/offline, counted only
)

func (k TopicKind) String() string {
	return [...]string{"unknown", "e", "c", "json", "map", "stat"}[k]
}

// Topic is a parsed MQTT topic. Nothing in it is authenticated.
type Topic struct {
	Kind    TopicKind
	Root    string // everything before "/2/", any depth (e.g. msh/EU_868/NO/Østlandet)
	Channel string // channel name segment (e and c topics)
	Gateway string // gateway segment as published, e.g. "!06f53d8c"
}

// MaxTopicLen bounds topic processing; MQTT allows 64 KiB but real
// Meshtastic topics are short.
const MaxTopicLen = 512

// ParseTopic anchors on the last "/2/{kind}/" marker so that roots of any
// depth work. Malformed topics yield Kind == TopicUnknown.
func ParseTopic(t string) Topic {
	if len(t) == 0 || len(t) > MaxTopicLen || !utf8.ValidString(t) {
		return Topic{}
	}
	segs := strings.Split(t, "/")
	for i := len(segs) - 2; i >= 1; i-- {
		if segs[i] != "2" {
			continue
		}
		root := strings.Join(segs[:i], "/")
		rest := segs[i+1:]
		switch rest[0] {
		case "e", "c":
			if len(rest) != 3 || rest[1] == "" || rest[2] == "" {
				return Topic{}
			}
			kind := TopicEncrypted
			if rest[0] == "c" {
				kind = TopicLegacyC
			}
			return Topic{Kind: kind, Root: root, Channel: rest[1], Gateway: rest[2]}
		case "json":
			return Topic{Kind: TopicJSON, Root: root}
		case "map":
			return Topic{Kind: TopicMap, Root: root}
		case "stat":
			gw := ""
			if len(rest) > 1 {
				gw = rest[1]
			}
			return Topic{Kind: TopicStat, Root: root, Gateway: gw}
		}
	}
	return Topic{}
}
