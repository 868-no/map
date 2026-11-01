package mqtt

import (
	"context"
	"net/url"
	"time"

	"github.com/eclipse/paho.golang/autopaho"
	"github.com/eclipse/paho.golang/paho"
	pahov3 "github.com/eclipse/paho.mqtt.golang"
)

// v5Client uses autopaho (MQTT 5) with automatic reconnect and resubscribe.
type v5Client struct{ *base }

func (c *v5Client) Run(ctx context.Context) error {
	tlsCfg, err := tlsConfig(c.cfg)
	if err != nil {
		return err
	}
	subs := make([]paho.SubscribeOptions, len(c.cfg.Topics))
	for i, t := range c.cfg.Topics {
		subs[i] = paho.SubscribeOptions{Topic: t.Filter, QoS: t.QoS}
	}
	cc := autopaho.ClientConfig{
		ServerUrls:                    []*url.URL{brokerURL(c.cfg)},
		TlsCfg:                        tlsCfg,
		KeepAlive:                     30,
		CleanStartOnInitialConnection: true,
		SessionExpiryInterval:         0,
		ConnectTimeout:                15 * time.Second,
		ReconnectBackoff:              Backoff,
		ConnectUsername:               c.cfg.Username,
		ConnectPassword:               []byte(c.cfg.Password),
		OnConnectionUp: func(cm *autopaho.ConnectionManager, _ *paho.Connack) {
			c.m.BrokerConnects.WithLabelValues(c.cfg.ID).Inc()
			c.log.Info("mqtt connected; subscribing")
			go func() {
				sctx, cancel := context.WithTimeout(ctx, 15*time.Second)
				defer cancel()
				sa, err := cm.Subscribe(sctx, &paho.Subscribe{Subscriptions: subs})
				var codes []byte
				if sa != nil {
					codes = sa.Reasons
				}
				c.subscribed(err, codes, len(subs))
			}()
		},
		OnConnectionDown: func() bool {
			c.setState(StateDown)
			c.log.Warn("mqtt connection lost")
			return true
		},
		OnConnectError: func(err error) {
			c.setState(StateDown)
			c.log.Warn("mqtt connect failed", "err", err)
		},
		ClientConfig: paho.ClientConfig{
			ClientID: c.cfg.ClientID,
			OnPublishReceived: []func(paho.PublishReceived) (bool, error){
				func(pr paho.PublishReceived) (bool, error) {
					c.deliver(pr.Packet.Topic, pr.Packet.Payload, pr.Packet.Retain)
					return true, nil
				},
			},
		},
	}
	cm, err := autopaho.NewConnection(ctx, cc)
	if err != nil {
		return err
	}
	<-cm.Done()
	c.setState(StateDown)
	return nil
}

// v3Client uses paho.mqtt.golang for brokers that only speak MQTT 3.1.1.
type v3Client struct{ *base }

func (c *v3Client) Run(ctx context.Context) error {
	tlsCfg, err := tlsConfig(c.cfg)
	if err != nil {
		return err
	}
	u := brokerURL(c.cfg)
	scheme := "tcp"
	if c.cfg.TLS.Enabled {
		scheme = "ssl"
	}
	o := pahov3.NewClientOptions().
		AddBroker(scheme + "://" + u.Host).
		SetClientID(c.cfg.ClientID).
		SetUsername(c.cfg.Username).
		SetPassword(c.cfg.Password).
		SetCleanSession(true).
		SetKeepAlive(30 * time.Second).
		SetAutoReconnect(true).
		SetConnectRetry(true).
		SetConnectRetryInterval(5 * time.Second).
		SetMaxReconnectInterval(time.Minute).
		SetOrderMatters(false)
	if tlsCfg != nil {
		o.SetTLSConfig(tlsCfg)
	}
	filters := map[string]byte{}
	for _, t := range c.cfg.Topics {
		filters[t.Filter] = t.QoS
	}
	o.SetOnConnectHandler(func(cl pahov3.Client) {
		c.m.BrokerConnects.WithLabelValues(c.cfg.ID).Inc()
		c.log.Info("mqtt connected; subscribing")
		tok := cl.SubscribeMultiple(filters, func(_ pahov3.Client, m pahov3.Message) {
			c.deliver(m.Topic(), m.Payload(), m.Retained())
		})
		go func() {
			if !tok.WaitTimeout(15 * time.Second) {
				c.subscribed(errSubscribeTimeout, nil, len(filters))
				return
			}
			codes := make([]byte, 0, len(filters))
			for _, q := range tok.(*pahov3.SubscribeToken).Result() {
				codes = append(codes, q)
			}
			c.subscribed(tok.Error(), codes, len(filters))
		}()
	})
	o.SetConnectionLostHandler(func(_ pahov3.Client, err error) {
		c.setState(StateDown)
		c.log.Warn("mqtt connection lost", "err", err)
	})
	o.SetReconnectingHandler(func(pahov3.Client, *pahov3.ClientOptions) { c.setState(StateConnecting) })
	cl := pahov3.NewClient(o)
	cl.Connect() // retries in background (SetConnectRetry)
	<-ctx.Done()
	cl.Disconnect(250)
	c.setState(StateDown)
	return nil
}
