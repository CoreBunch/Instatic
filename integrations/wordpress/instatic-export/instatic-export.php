<?php
/**
 * Plugin Name: Instatic Migration Exporter
 * Description: Exports a private source package for the Instatic WordPress migration pilot.
 * Version: 0.1.0
 */
namespace Instatic\Migration;
defined('ABSPATH') || exit;

require_once __DIR__ . '/capture.php';

// Unregistered public custom fields can have repeated values. Read the stored
// strings verbatim; leave protected/plugin-internal metadata to named adapters.
function public_metadata($id) {
    $meta = get_post_meta($id);
    return array_filter($meta, static function ($key) {
        return !is_protected_meta($key, 'post');
    }, ARRAY_FILTER_USE_KEY);
}

function export_package($path) {
    if (!class_exists('ZipArchive')) {
        throw new \RuntimeException('Enable PHP zip to export this site.');
    }
    $zip = new \ZipArchive();
    if ($zip->open($path, \ZipArchive::CREATE | \ZipArchive::OVERWRITE) !== true) {
        throw new \RuntimeException('Cannot open export file.');
    }
    $capture = new Capture($zip);
    $source = [
        'version' => 1, 'site' => home_url('/'), 'blog' => get_current_blog_id(),
        'name' => get_bloginfo('name'), 'date' => gmdate('c'), 'types' => [], 'posts' => [],
        'taxonomies' => [], 'media' => [], 'warnings' => [], 'inventory' => [],
    ];
    foreach (get_post_types([], 'objects') as $type) {
        $name = $type->name;
        $source['inventory'][$name] = (array) wp_count_posts($name);
        if (!in_array($name, ['page', 'post'], true) && ($type->_builtin || !$type->public)) {
            continue;
        }
        $fields = [];
        if (function_exists('acf_get_field_groups')) {
            foreach (acf_get_field_groups(['post_type' => $name]) as $group) {
                foreach (acf_get_fields($group) ?: [] as $field) {
                    $fields[$field['key']] = array_intersect_key($field, array_flip(['key','name','label','type','post_type','multiple','choices','sub_fields']));
                }
            }
        }
        $archive = get_post_type_archive_link($name);
        if ($name === 'post' && get_option('show_on_front') !== 'posts' && !get_option('page_for_posts')) $archive = false;
        $entry = ['name' => $name, 'label' => $type->labels->name, 'singular' => $type->labels->singular_name,
            'fields' => array_values($fields), 'archive' => $archive ?: '', 'archiveHtml' => ''];
        if ($archive && $name !== 'page') {
            $entry['archiveHtml'] = $capture->document($archive);
        }
        $source['types'][] = $entry;
        $statuses = array_values(array_diff(get_post_stati(), ['auto-draft','inherit','trash']));
        for ($page = 1; ; $page++) {
            $posts = get_posts(['post_type' => $name, 'post_status' => $statuses, 'posts_per_page' => 100,
                'paged' => $page, 'orderby' => 'ID', 'order' => 'ASC', 'suppress_filters' => false]);
            foreach ($posts as $post) {
                $id = $post->ID;
                $public = $post->post_status === 'publish' && $post->post_password === '';
                $permalink = get_permalink($post);
                $terms = [];
                foreach (get_object_taxonomies($name) as $taxonomy) {
                    $ids = wp_get_object_terms($id, $taxonomy, ['fields' => 'ids']);
                    if (is_wp_error($ids)) throw new \RuntimeException($ids->get_error_message());
                    $terms[$taxonomy] = $ids;
                }
                $values = [];
                foreach ($fields as $field) {
                    if (metadata_exists('post', $id, $field['name'])) {
                        $values[$field['key']] = get_field($field['key'], $id, false);
                    }
                }
                $shortcodes = [];
                if (preg_match_all('/\[(?!\/)([a-zA-Z][\w-]*)\b/', $post->post_content, $matches)) {
                    $shortcodes = array_values(array_unique($matches[1]));
                }
                $source['posts'][] = ['id' => $id, 'type' => $name, 'slug' => $post->post_name,
                    'title' => $post->post_title, 'status' => $post->post_status, 'public' => $public, 'passwordProtected' => $post->post_password !== '',
                    'parent' => $post->post_parent, 'author' => $post->post_author,
                    'publicMeta' => (object)public_metadata($id),
                    'authorName' => get_the_author_meta('display_name', $post->post_author),
                    'date' => $post->post_date_gmt, 'modified' => $post->post_modified_gmt,
                    'url' => $permalink ?: '', 'raw' => $post->post_content, 'blocks' => parse_blocks($post->post_content),
                    'fields' => (object)$values, 'terms' => (object)$terms, 'shortcodes' => $shortcodes,
                    'featured' => (int)get_post_thumbnail_id($id),
                    'html' => $public && $permalink ? $capture->document($permalink) : ''];
            }
            if (count($posts) < 100) break;
        }
    }
    foreach (get_taxonomies([], 'objects') as $tax) {
        if (!array_intersect($tax->object_type, array_column($source['types'], 'name'))) continue;
        $terms = get_terms(['taxonomy' => $tax->name, 'hide_empty' => false]);
        if (is_wp_error($terms)) throw new \RuntimeException($terms->get_error_message());
        $source['taxonomies'][] = ['name' => $tax->name, 'label' => $tax->label, 'types' => $tax->object_type,
            'terms' => array_map(static function ($term) {
                return ['id' => $term->term_id, 'name' => $term->name, 'slug' => $term->slug, 'parent' => $term->parent];
            }, $terms)];
    }
    // Only assets used by a public render or explicitly selected in a public media field enter the native library.
    $media_ids = [];
    foreach ($source['posts'] as $post) {
        if (!$post['public']) continue;
        $media_ids[] = $post['featured'];
        foreach ($source['types'] as $type) {
            if ($type['name'] !== $post['type']) continue;
            foreach ($type['fields'] as $field) {
                if (in_array($field['type'], ['gallery','image','file'], true)) {
                    $media_ids = array_merge($media_ids, (array)($post['fields']->{$field['key']} ?? []));
                }
            }
        }
    }
    foreach (array_unique(array_filter($media_ids)) as $id) {
        $url = wp_get_attachment_url($id);
        if (!$url) continue;
        $capture->asset($url, home_url('/'));
        $source['media'][] = ['id' => (int)$id, 'url' => $url, 'alt' => (string)get_post_meta($id, '_wp_attachment_image_alt', true),
            'caption' => (string)wp_get_attachment_caption($id), 'title' => get_the_title($id)];
    }
    $source['homeHtml'] = $capture->document(home_url('/'));
    $source['warnings'] = array_values(array_unique($capture->warnings));
    $json = wp_json_encode($source, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
    if (!$zip->addFromString('instatic-wordpress-source.json', $json) || !$zip->close()) throw new \RuntimeException('Could not finalize ZIP.');
}

if (defined('WP_CLI') && WP_CLI) {
    \WP_CLI::add_command('instatic export', function ($args) {
        if (count($args) !== 1 || file_exists($args[0])) \WP_CLI::error('Supply a new private output file path.');
        $tmp = tempnam(sys_get_temp_dir(), 'instatic-');
        if (!$tmp) throw new \RuntimeException('Cannot create private temporary file.');
        try {
            export_package($tmp);
            $previous = umask(0077);
            try { $out = fopen($args[0], 'xb'); } finally { umask($previous); }
            if (!$out) throw new \RuntimeException('Could not create output.');
            $in = fopen($tmp, 'rb');
            try {
                if (stream_copy_to_stream($in, $out) !== filesize($tmp)) throw new \RuntimeException('Incomplete export copy.');
            } finally { fclose($in); fclose($out); }
        } finally { wp_delete_file($tmp); }
        \WP_CLI::success('Created private WordPress source package.');
    });
}

add_action('admin_menu', function () {
    add_management_page('Instatic export', 'Instatic export', 'manage_options', 'instatic-export', function () {
        echo '<div class="wrap"><h1>Export to Instatic</h1><p>This private download includes unpublished content. Keep it outside the public web root.</p><form method="post" action="' . esc_url(admin_url('admin-post.php')) . '">';
        wp_nonce_field('instatic_export');
        echo '<input type="hidden" name="action" value="instatic_export">';
        submit_button('Download migration package');
        echo '</form></div>';
    });
});
add_action('admin_post_instatic_export', function () {
    if (!current_user_can('manage_options')) wp_die('Forbidden', '', ['response' => 403]);
    check_admin_referer('instatic_export');
    $tmp = tempnam(sys_get_temp_dir(), 'instatic-');
    if (!$tmp) wp_die('Cannot create private temporary file.');
    try {
        export_package($tmp);
        nocache_headers();
        header('Content-Type: application/zip');
        header('Content-Disposition: attachment; filename="wordpress-source.zip"');
        readfile($tmp);
    } finally { wp_delete_file($tmp); }
    exit;
});
