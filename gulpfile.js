'use strict';

var gulp = require('gulp');
var postcss = require('gulp-postcss');
var easysprite = require('./index.js');
var rename = require('gulp-rename');

gulp.task('test', ['project'], function() {
    var mocha = require('gulp-mocha');
    return gulp.src('test/*.js', { read: false })
      .pipe(mocha());
});

gulp.task('project', function(){

    gulp.src('./test/basic/input.css')
      .pipe(postcss([
        easysprite({
          imagePath:'/test/basic/', 
          spritePath: '/test/basic/sprites/'
        })
      ]))
      .pipe(rename('output.css'))
      .pipe(gulp.dest('./test/basic/'));
});

gulp.task('default', ['project']);

gulp.task('watch', function() {
    gulp.watch('test/{**/*,*.*}', ['project']);
});