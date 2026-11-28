<?php
// WP-CLI eval-file, exclusively on a newly installed disposable site.
if (get_bloginfo('name') !== 'Instatic disposable migration fixture' || get_option('instatic_fixture_seeded')) {
    throw new RuntimeException('Expected a new Instatic disposable migration fixture.');
}
update_option('instatic_fixture_seeded', true);
function pilot_post($type, $title, $status = 'publish') {
    return wp_insert_post(['post_type'=>$type,'post_status'=>$status,'post_title'=>$title,
        'post_content'=>'<!-- wp:paragraph --><p>'.esc_html($title).' editorial body.</p><!-- /wp:paragraph -->'], true);
}
$home = pilot_post('page','Studio home');
update_option('show_on_front','page');
update_option('page_on_front',$home);
$client = pilot_post('client','Cedar');
$parent = wp_insert_term('Design','discipline')['term_id'];
$term = wp_insert_term('Identity','discipline',['parent'=>$parent])['term_id'];
$media = [];
foreach (['blue', 'green'] as $color) {
    $image = imagecreatetruecolor(12,12);
    imagefill($image,0,0,imagecolorallocate($image,0,$color === 'green' ? 255 : 0,$color === 'blue' ? 255 : 0));
    ob_start(); imagepng($image); $bytes = ob_get_clean();
    $upload = wp_upload_bits($color.'.png',null,$bytes);
    $id = wp_insert_attachment(['post_title'=>$color,'post_mime_type'=>'image/png','post_status'=>'inherit'], $upload['file']);
    update_attached_file($id, $upload['file']);
    update_post_meta($id,'_wp_attachment_image_alt',$color.' sample');
    $media[] = $id;
}
foreach (['Atlas'=>'Aster studio','Orion'=>'Birch studio'] as $title => $studio) {
    $id = pilot_post('project',$title);
    update_field('field_studio',$studio,$id);
    update_field('field_client',$client,$id);
    update_field('field_gallery',$media,$id);
    wp_set_object_terms($id,[$term],'discipline');
    set_post_thumbnail($id,$media[0]);
    if ($title === 'Orion') wp_update_post(['ID'=>$id,'post_content'=>get_post_field('post_content',$id).' [pilot_missing]']);
}
pilot_post('project','Unreleased sketch','draft');
pilot_post('project','Private commission','private');
flush_rewrite_rules();
