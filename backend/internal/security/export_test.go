package security

import (
	"crypto/aes"

	"github.com/pion/dtls/v3/pkg/crypto/ccm"
)

var (
	aesNewCipher = aes.NewCipher
	ccmNew       = ccm.NewCCM
)
