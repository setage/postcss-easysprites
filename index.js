var postcss = require('postcss');
var Q = require('q');
var lodash = require('lodash');
var url = require('url');
var path = require('path');
var chalk = require('chalk');
var async = require('async');
var spritesmith = require('spritesmith');
var mkdirp = require('mkdirp');
var fs = require('fs');
var md5 = require('md5');
var cache = {};

/**
 * Constants.
 *
 * @type {String}
 */
var GROUP_DELIMITER   = '.';
var GROUP_MASK        = '*';
var BACKGROUND        = 'background';
var BACKGROUND_IMAGE  = 'background-image';
var BACKGROUND_COLOR  = 'background-color';
var BACKGROUND_REPEAT = 'background-repeat';
var BACKGROUND_SIZE   = 'background-size';

module.exports = postcss.plugin('postcss-easysprite', function (opts) {
    opts = opts || {};

    // Work with options here
    opts = opts || {};
    opts.imagePath = opts.imagePath ? process.cwd() + opts.imagePath : process.cwd();
    opts.groupBy = opts.groupBy || [];
    opts.stylesheetPath = opts.stylesheetPath ? process.cwd()+opts.stylesheetPath : false;
    opts.spritePath = opts.spritePath ? process.cwd()+opts.spritePath : false;

    // Group retina images
    opts.groupBy.unshift(function(image) {
      if (image.ratio>1) { return '@' + image.ratio + 'x'; }
      return null;
    });

    return function (css) {
      return Q
        .all([collectImages(css, opts), opts])
        .spread(applyGroupBy)
        .spread(function(images, opts){
          return setTokens(images, opts, css);
        })
        .spread(runSpriteSmith)
        .spread(saveSprites)
        .spread(mapSpritesProperties)
        .spread(function(images, opts, sprites) {
          return updateReferences(images, opts, sprites, css);
        });
    };
});


function collectImages(css, opts) {
  var images = [];
  if (!opts.stylesheetPath) { opts.stylesheetPath = css.source.input.file; }

  css.eachRule(function(rule) {
    var image = {
      path    : null,
      url     : null,
      ratio   : 1,
      groups  : [],
      token   : ''
    };

    if (hasImageInRule(rule.toString())) {
      image.url = getImageUrl(rule.toString());
      var imageUrl = url.parse(image.url);

      // only locals, hashed paths
      if (imageUrl.host ||
          !imageUrl.hash ||
          imageUrl.pathname.indexOf('//') === 0 ||
          imageUrl.pathname.indexOf(';base64') !== -1) {
        return;
      }

      image.groups = [imageUrl.hash.replace('#','')];

      // Perform search for retina
      if (isRetinaImage(image.url)) {
        image.ratio  = getRetinaRatio(image.url);
      }

      // Get the path to the image.
      image.path = resolveUrl(image, opts);

      images.push(image);
    }
  });

  return images;
}

function applyGroupBy(images, opts) {
  return Q.Promise(function(resolve, reject) {
    async.reduce(opts.groupBy, images, function(images, group, next) {
      async.map(images, function(image, done) {
        new Q(group(image))
          .then(function(group) {
            if (group) {
              image.groups.push(group);
            }

            done(null, image);
          })
          .catch(done);
      }, next);
    }, function(err, images) {
      if (err) {
        return reject(err);
      }

      resolve([images, opts]);
    });
  });
}

function setTokens(images, opts, css) {
  return Q.Promise(function(resolve) {
    css.eachDecl(/^background(-image)?$/, function(decl) {
      var rule = decl.parent;
      var url, image, color;

      // Manipulate only rules with background image
      // in them.
      if (hasImageInRule(rule.toString())) {
        url   = getImageUrl(rule.toString());
        image = lodash.find(images, { url: url });

        if (image) {
          // We remove these declarations since
          // our plugin will insert them when
          // they are necessary.
          rule.eachDecl(/^background-(repeat|size|position)$/, function(decl) {
            decl.removeSelf();
          });

          if (decl.prop === BACKGROUND) {
            color = getColor(decl);

            // Extract color to background-color propery
            if (color && color.length === 1) {
              rule.append({
                prop: 'background-color',
                value: color[0],
                before: ' '
              });
            }
          }

          if (decl.prop === BACKGROUND || decl.prop === BACKGROUND_IMAGE) {
            image.token = postcss.comment({
              text: image.url,
              before: ' ',
              left: '@replace|',
              right: ''
            });

            // Replace the declaration with a comment token
            // which will be used later for reference.
            decl.replaceWith(image.token);
          }
        }
      }
    });

    resolve([images, opts]);
  });
}

function runSpriteSmith(images, opts) {
  return Q.Promise(function(resolve, reject) {
    var all = lodash
      .chain(images)
      .groupBy(function (image) {
        var temp;

        temp = image.groups.map(mask(true));
        temp.unshift('_');

        return temp.join(GROUP_DELIMITER);
      })
      .map(function(images, temp) {
        var config = lodash.merge({}, opts, {
          src: lodash.pluck(images, 'path')
        });
        var ratio;

        // Enlarge padding for retina images
        if (areAllRetina(images)) {
          ratio = lodash
            .chain(images)
            .flatten('ratio')
            .unique()
            .value();

          if (ratio.length === 1) {
            config.padding = config.padding * ratio[0];
          }
        }

        var checkstring = [];
        // collect images datechanged
        lodash.each(config.src, function(image){
          checkstring.push(image+'='+md5(fs.readFileSync(image).toString()));
        });
        checkstring = md5(checkstring.join('&'));
        
        if (cache[checkstring]) {
          console.log('Easysprite:', chalk.green.underline(temp.replace(/^_./,'')).replace(/.@/,'@'), 'unchanged.');
          return Q.nfcall(function(){});
        }

        cache[checkstring] = true;

        return Q.nfcall(spritesmith, config)
          .then(function(result) {
            temp = temp.split(GROUP_DELIMITER);
            temp.shift();

            // Append info about sprite group
            result.groups = temp.map(mask(false));

            return result;
          });
      })
      .value();

    Q.all(all)
      .then(function(results) {
        resolve([images, opts, results]);
      })
      .catch(function(err) {
        if (err) {
          reject(err);
        }
      });
  });
}

function saveSprites(images, opts, sprites) {
  return Q.Promise(function(resolve, reject) {

    if (!fs.existsSync(opts.spritePath)) {
      mkdirp.sync(opts.spritePath);
    }
    var all = lodash
      .chain(sprites)
      .map(function(sprite) {
        sprite.path = makeSpritePath(opts, sprite.groups);

        return Q.nfcall(fs.writeFile, sprite.path, new Buffer(sprite.image, 'binary'))
          .then(function() {
            console.log('Easysprite:', chalk.yellow.underline(sprite.path), 'generated.');
            return sprite;
          });
      })
      .value();

    Q.all(all)
      .then(function(sprites) {
        resolve([images, opts, sprites]);
      })
      .catch(function(err) {
        if (err) {
          reject(err);
        }
      });
  });
}


/**
 * Map properties for every image.
 *
 * @param  {Array}  images
 * @param  {Object} opts
 * @param  {Array}  sprites
 * @return {Promise}
 */
function mapSpritesProperties(images, opts, sprites) {
  return Q.Promise(function(resolve) {
    sprites = lodash.map(sprites, function(sprite) {
      return lodash.map(sprite.coordinates, function (coordinates, imagePath) {
        return lodash.merge(lodash.find(images, { path: imagePath }), {
          coordinates: coordinates,
          spritePath: sprite.path,
          properties: sprite.properties
        });
      });
    });

    resolve([images, opts, sprites]);
  });
}

function updateReferences(images, opts, sprites, css) {
  return Q.Promise(function(resolve) {
    css.eachComment(function(comment) {
      var rule, image, backgroundImage, backgroundPosition, backgroundSize;

      // Manipulate only token comments
      if (isToken(comment)) {
        image = lodash.find(images, { url: comment.text });

        if (image) {
          // Generate correct ref to the sprite
          image.spriteRef = path.relative(opts.stylesheetPath, image.spritePath);
          image.spriteRef = image.spriteRef.split(path.sep).join('/');

          backgroundImage = postcss.decl({
            prop: 'background-image',
            value: getBackgroundImageUrl(image)
          });

          backgroundPosition = postcss.decl({
            prop: 'background-position',
            value: getBackgroundPosition(image)
          });

          // Replace the comment and append necessary properties.
          comment.replaceWith(backgroundImage);

          // Output the dimensions
          rule = backgroundImage.parent;
          if (opts.outputDimensions) {
            ['height', 'width'].forEach(function(prop) {
              rule.insertAfter(backgroundImage, postcss.decl({
                prop: prop,
                value: (image.retina ? image.coordinates[prop] / image.ratio : image.coordinates[prop]) + 'px'
              }));
            });
          }

          rule.insertAfter(backgroundImage, backgroundPosition);

          if (image.retina) {
            backgroundSize = postcss.decl({
              prop: 'background-size',
              value: getBackgroundSize(image)
            });

            backgroundPosition.parent.insertAfter(backgroundPosition, backgroundSize);
          }
        }
      }
    });

    resolve([images, opts, sprites, css]);
  });
}


/**
 * Generate a path to the sprite.
 *
 * @param  {Object} opts
 * @param  {Array}  groups
 * @return {String}
 */
function makeSpritePath(opts, groups) {

  var base   = opts.spritePath;
  var file = base + groups.join('.') + '.png';
  return file.replace('.@', '@');
}


function mask(toggle) {
  var input  = new RegExp('[' + (toggle ? GROUP_DELIMITER : GROUP_MASK) + ']', 'gi');
  var output = toggle ? GROUP_MASK : GROUP_DELIMITER;

  return function(value) {
    return value.replace(input, output);
  };
}

function resolveUrl(image, opts) {
  var results;
  if (/^\//.test(image.url)) {
    results = path.resolve(opts.imagePath+image.url);
  } else {
    results = path.resolve(opts.stylesheetPath.substring(0, opts.stylesheetPath.lastIndexOf(path.sep)), image.url);
  }

  // get rid of get params and hash;
  return results.split('#')[0].split('?')[0];
}


/**
 * Check that the declaration is background.
 * E.g. background-image, background, etc.
 *
 * @param  {Object}  decl
 * @return {Boolean}
 */
function isBackgroundDecl(decl) {
  return /^background/gi.test(decl.prop);
}

/**
 * Check for url in the given rule.
 *
 * @param  {String}  rule
 * @return {Boolean}
 */
function hasImageInRule(rule) {
  return /background[^:]*.*url[^;]+;/gi.test(rule);
}

/**
 * Extract the path to image from the url in given rule.
 *
 * @param  {String} rule
 * @return {String}
 */
function getImageUrl(rule) {
  var match = /background[^:]*:.*url\(([\S]+)\)/gi.exec(rule);

  return match ? match[1].replace(/['"]/gi, '') : '';
}

/**
 * Extract the background color from declaration.
 *
 * @param  {Object} decl
 * @return {String|null}
 */
function getColor(decl) {
  var regexes = ['(#([0-9a-f]{3}){1,2})', 'rgba?\\([^\\)]+\\)'];
  var matches = null;

  lodash.forEach(regexes, function(regex) {
    regex = new RegExp(regex, 'gi');

    if (regex.test(decl.value)) {
      matches = decl.value.match(regex);
    }
  });

  return matches;
}

/**
 * Check whether the comment is token that
 * should be replaced with CSS declarations.
 *
 * @param  {Object}  comment
 * @return {Boolean}
 */
function isToken(comment) {
  return /@replace/gi.test(comment.toString());
}

/**
 * Return the value for background-image property.
 *
 * @param  {Object} image
 * @return {String}
 */
function getBackgroundImageUrl(image) {
  var template = lodash.template('url(<%= image.spriteRef %>)');

  return template({ image: image });
}

/**
 * Return the value for background-position property.
 *
 * @param  {Object} image
 * @return {String}
 */
function getBackgroundPosition(image) {
  var x        = -1 * (image.retina ? image.coordinates.x / image.ratio : image.coordinates.x);
  var y        = -1 * (image.retina ? image.coordinates.y / image.ratio : image.coordinates.y);
  var template = lodash.template('<%= (x ? x + "px" : x) %> <%= (y ? y + "px" : y) %>');

  return template({ x: x, y: y });
}

/**
 * Return the value for background-size property.
 *
 * @param  {Object} image
 * @return {String}
 */
function getBackgroundSize(image) {
  var x        = image.properties.width / image.ratio;
  var y        = image.properties.height / image.ratio;
  var template = lodash.template('<%= x %>px <%= y %>px');

  return template({ x: x, y: y });
}


/**
 * Check whether the image is retina.
 * @param  {String}  url
 * @return {Boolean}
 */
function isRetinaImage(url) {
  return /@(\d)x\.[a-z]{3,4}$/gi.test(url.split('#')[0]);
}

/**
 * Return the retina ratio.
 *
 * @param  {String} url
 * @return {Number}
 */
function getRetinaRatio(url) {
  var matches = /@(\d)x\.[a-z]{3,4}$/gi.exec(url.split('#')[0]);
  var ratio   = lodash.parseInt(matches[1]);

  return ratio;
}

/**
 * Check whether all images are retina.
 *
 * @param  {Array}  images
 * @return {Boolean}
 */
function areAllRetina(images) {
  return lodash.every(images, function(image) {
    return image.retina;
  });
}