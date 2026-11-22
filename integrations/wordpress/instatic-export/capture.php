<?php
namespace Instatic\Migration;
defined('ABSPATH') || exit;

final class Capture {
    public $warnings = [];
    private $zip;
    private $seen = [];

    public function __construct($zip) { $this->zip = $zip; }

    private function local($url) {
        $home = wp_parse_url(home_url('/'));
        $part = wp_parse_url($url);
        return isset($part['host'], $part['scheme']) && !isset($part['user']) && !isset($part['pass'])
            && strtolower($part['host']) === strtolower($home['host']) && $part['scheme'] === $home['scheme']
            && ($part['port'] ?? null) === ($home['port'] ?? null);
    }

    private function read($url) {
        if (!$this->local($url)) return null;
        $response = wp_remote_get($url, ['redirection' => 0, 'timeout' => 20, 'limit_response_size' => 16 * MB_IN_BYTES + 1,
            'cookies' => [], 'headers' => ['Accept-Encoding' => 'identity']]);
        $bytes = is_wp_error($response) ? null : wp_remote_retrieve_body($response);
        if ($bytes === null || wp_remote_retrieve_response_code($response) !== 200 || strlen($bytes) > 16 * MB_IN_BYTES) {
            $this->warnings[] = 'Could not capture ' . $url;
            return null;
        }
        return $bytes;
    }

    public function asset($ref, $base) {
        if (!$ref || preg_match('/^(?:data:|blob:|#)/i', $ref)) return;
        $url = \WP_Http::make_absolute_url(html_entity_decode($ref, ENT_QUOTES), $base);
        $path = ltrim((string)wp_parse_url($url, PHP_URL_PATH), '/');
        if (!preg_match('/\.(css|js|jpe?g|png|gif|webp|avif|svg|ico|woff2?|ttf|otf|pdf|mp4)$/i', $path)) return;
        if (!$this->local($url)) { $this->warnings[] = 'External asset: ' . $url; return; }
        if (str_contains(rawurldecode($path), '..') || str_contains($path, '\\')) return;
        if (isset($this->seen[$path])) return;
        $this->seen[$path] = true;
        $bytes = $this->read($url);
        if ($bytes === null) return;
        if (!$this->zip->addFromString('assets/' . $path, $bytes)) throw new \RuntimeException('Could not add ' . $path);
        if (preg_match('/\.css$/i', $path)) $this->css($bytes, $url);
    }

    private function css($text, $base) {
        preg_match_all('~(?:url\(\s*["\']?([^"\')]+)|@import\s+["\']([^"\']+))~i', $text, $matches, PREG_SET_ORDER);
        foreach ($matches as $match) $this->asset(trim($match[1] ?: $match[2]), $base);
    }

    public function document($url) {
        $html = $this->read($url);
        if ($html === null) return '';
        $doc = new \DOMDocument();
        $doc->loadHTML($html, LIBXML_NONET | LIBXML_NOERROR | LIBXML_NOWARNING);
        foreach ($doc->getElementsByTagName('*') as $node) {
            foreach (['src','poster'] as $attr) if ($node->hasAttribute($attr)) $this->asset($node->getAttribute($attr), $url);
            if ($node->tagName === 'link') $this->asset($node->getAttribute('href'), $url);
            if ($node->hasAttribute('srcset')) foreach (explode(',', $node->getAttribute('srcset')) as $candidate) {
                $this->asset(preg_split('/\s+/', trim($candidate))[0], $url);
            }
            if ($node->tagName === 'style') $this->css($node->textContent, $url);
            if ($node->hasAttribute('style')) $this->css($node->getAttribute('style'), $url);
        }
        return $html;
    }
}
