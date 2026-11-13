// SPDX-License-Identifier: AGPL-3.0-or-later

package main

import (
	"strings"
	"testing"
)

const all = "SID=sid; HSID=hsid; SSID=ssid; APISID=apisid; SAPISID=sapisid; OSID=osid; __Secure-1PSIDTS=ts; NID=other"

func check(t *testing.T, name string, got map[string]string, err error) {
	t.Helper()
	if err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	want := map[string]string{"SID": "sid", "HSID": "hsid", "SSID": "ssid", "APISID": "apisid", "SAPISID": "sapisid", "OSID": "osid", "__Secure-1PSIDTS": "ts"}
	if len(got) != len(want) {
		t.Errorf("%s: only the cookies pairing uses are kept: %v", name, got)
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s: %s = %q", name, k, got[k])
		}
	}
}

func TestCookieForms(t *testing.T) {
	got, err := ParseCookies(all)
	check(t, "a Cookie header", got, err)
	got, err = ParseCookies("Cookie: " + all)
	check(t, "with its name", got, err)
	got, err = ParseCookies(`{"SID":"sid","HSID":"hsid","SSID":"ssid","APISID":"apisid","SAPISID":"sapisid","OSID":"osid","__Secure-1PSIDTS":"ts","n":1}`)
	check(t, "a JSON object", got, err)
	got, err = ParseCookies(`[{"name":"SID","value":"sid","domain":".google.com"},{"name":"HSID","value":"hsid","domain":".google.com"},
		{"name":"SSID","value":"ssid","domain":".google.com"},{"name":"APISID","value":"apisid","domain":".google.com"},
		{"name":"SAPISID","value":"sapisid","domain":".google.com"},{"name":"OSID","value":"osid","domain":"messages.google.com"},
		{"name":"OSID","value":"wrong","domain":"myaccount.google.com"},{"name":"SID","value":"evil","domain":".example.com"},
		{"name":"__Secure-1PSIDTS","value":"ts","domain":".google.com"}]`)
	check(t, "a cookie export", got, err)
	got, err = ParseCookies(`curl 'https://messages.google.com/web/config' \
  -H 'accept: */*' \
  -H 'cookie: ` + all + `' \
  -H 'user-agent: Mozilla/5.0'`)
	check(t, "Copy as cURL (Chrome)", got, err)
	got, err = ParseCookies(`curl "https://messages.google.com/web/config" -b "` + all + `"`)
	check(t, "Copy as cURL with -b", got, err)
}

func TestCookieErrors(t *testing.T) {
	for _, c := range []struct{ in, want string }{
		{"", "no cookies"},
		{"SID=1; HSID=2", "missing Google cookies APISID, OSID, SAPISID, SSID"},
		{"{nope", "not a JSON object"},
		{"curl 'https://messages.google.com/' -H 'accept: */*'", "has no cookies"},
	} {
		_, err := ParseCookies(c.in)
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%q: %v", c.in, err)
		}
	}
}
