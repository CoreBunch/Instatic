<!doctype html><html><head><title><?php echo esc_html(wp_get_document_title()); ?></title><meta charset="utf-8"><link rel="stylesheet" href="<?php echo esc_url(get_stylesheet_uri()); ?>"></head><body><header><nav><a href="<?php echo esc_url(home_url('/work/')); ?>">Work</a></nav></header><main><?php
if (is_post_type_archive('project')) {
    echo '<h1>Projects</h1><div class="posts-list">';
    while (have_posts()) { the_post(); echo '<article><a href="' . esc_url(get_permalink()) . '">' . esc_html(get_the_title()) . '</a></article>'; }
    echo '</div>';
} else {
    while (have_posts()) {
        the_post();
        echo '<h1 class="entry-title work-title">' . esc_html(get_the_title()) . '</h1><div class="entry-content">';
        the_content();
        echo '</div>';
        if (is_singular('project')) {
            echo '<p class="studio">' . esc_html(get_field('studio')) . '</p><div class="gallery">';
            foreach ((array)get_field('gallery', false, false) as $image) echo wp_get_attachment_image($image, 'full');
            echo '</div>';
        }
        if (is_front_page()) echo '<form id="contact" method="post"><label>Email<input type="email" name="email" required></label><button type="submit">Contact us</button></form>';
    }
}
?></main><footer>Pilot Studio</footer></body></html>
