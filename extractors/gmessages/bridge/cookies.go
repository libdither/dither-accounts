// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Google account cookies for pairing by Google account (messages.google.com's way since Google retired QR pairing):
// read from what a person can copy out of their own browser. A JSON object {"SID": "...", ...}, a cookie export (a
// JSON array of {name, value}), a cURL command copied from the browser's network tab ("Copy as cURL"), or a bare
// Cookie header ("SID=...; HSID=...").

package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// RequiredCookies are the ones libgm cannot pair without (mautrix-gmessages' list).
var RequiredCookies = []string{"SID", "HSID", "SSID", "APISID", "SAPISID", "OSID"}

// WantedCookies are the ones kept: the required ones and __Secure-1PSIDTS, which Google rotates and checks.
var WantedCookies = append(append([]string{}, RequiredCookies...), "__Secure-1PSIDTS")

var curlCookieFlag = regexp.MustCompile(`(?s)(?:-b|--cookie)\s+(?:'([^']*)'|"((?:[^"\\]|\\.)*)"|(\S+))`)
var curlCookieHeader = regexp.MustCompile(`(?is)(?:-H|--header)\s+(?:'cookie:\s*([^']*)'|"cookie:\s*((?:[^"\\]|\\.)*)")`)

// ParseCookies reads Google cookies from any of the accepted forms and keeps only the ones pairing uses.
func ParseCookies(raw string) (map[string]string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, errors.New("no cookies given")
	}
	all := map[string]string{}
	switch {
	case strings.HasPrefix(raw, "{"):
		var m map[string]any
		if err := json.Unmarshal([]byte(raw), &m); err != nil {
			return nil, fmt.Errorf("the cookies are not a JSON object: %w", err)
		}
		for k, v := range m {
			if s, ok := v.(string); ok {
				all[k] = s
			}
		}
	case strings.HasPrefix(raw, "["):
		var list []struct {
			Name   string `json:"name"`
			Value  string `json:"value"`
			Domain string `json:"domain"`
		}
		if err := json.Unmarshal([]byte(raw), &list); err != nil {
			return nil, fmt.Errorf("the cookies are not a JSON list of {name, value}: %w", err)
		}
		for _, c := range list {
			// A Google account has these on .google.com; OSID is messages.google.com's own.
			if c.Domain != "" && !strings.HasSuffix(strings.TrimPrefix(c.Domain, "."), "google.com") {
				continue
			}
			if _, seen := all[c.Name]; !seen || c.Domain == ".google.com" || c.Domain == "messages.google.com" {
				all[c.Name] = c.Value
			}
		}
	case strings.HasPrefix(raw, "curl "):
		var header string
		if m := curlCookieHeader.FindStringSubmatch(raw); m != nil {
			header = m[1] + m[2]
		} else if m := curlCookieFlag.FindStringSubmatch(raw); m != nil {
			header = m[1] + m[2] + m[3]
		} else {
			return nil, errors.New("that cURL command has no cookies (copy it from a request to messages.google.com while signed in)")
		}
		parseHeader(strings.ReplaceAll(header, `\"`, `"`), all)
	default:
		parseHeader(strings.TrimPrefix(strings.TrimPrefix(raw, "Cookie:"), "cookie:"), all)
	}
	out := map[string]string{}
	for _, k := range WantedCookies {
		if v := strings.TrimSpace(all[k]); v != "" {
			out[k] = v
		}
	}
	var missing []string
	for _, k := range RequiredCookies {
		if out[k] == "" {
			missing = append(missing, k)
		}
	}
	if len(missing) > 0 {
		sort.Strings(missing)
		return nil, fmt.Errorf("missing Google cookies %s (sign in at messages.google.com first, then copy them from there)", strings.Join(missing, ", "))
	}
	return out, nil
}

func parseHeader(h string, into map[string]string) {
	for _, part := range strings.Split(h, ";") {
		k, v, ok := strings.Cut(strings.TrimSpace(part), "=")
		if ok && k != "" {
			into[strings.TrimSpace(k)] = strings.TrimSpace(v)
		}
	}
}
