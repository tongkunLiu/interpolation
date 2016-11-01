
var through = require('through2'),
    polyline = require('polyline'),
    project = require('../../lib/project'),
    analyze = require('../../lib/analyze'),
    interpolate = require('../../lib/interpolate');

// polyline precision
var PRECISION = 6;

/**
  this stream performs all the interpolation math for a road segment and pushes
  downstream rows to be inserted in the 'street_address' table.
**/
function streamFactory(db, done){

  // create a new stream
  return through.obj(function(rows, _, next ){

    // decode polyline
    var street = {
      id: rows[0].id,
      coordinates: project.dedupe( polyline.toGeoJSON(rows[0].line, PRECISION).coordinates )
    };

    // store an array of housenumbers and their distance along the linestring
    var distances = [];

    // process all house number entries in batch
    rows.forEach( function( row ){

      // get variables from db row
      var point = [ parseFloat(row.proj_lon), parseFloat(row.proj_lat) ];
      var housenumber = parseFloat(row.housenumber);
      var parity = '' + row.parity;

      // compute the distance along the linestring to the projected point
      var proj = project.pointOnLine( street.coordinates, point );
      var dist = project.lineDistance( project.sliceLineAtProjection( street.coordinates, proj ) );
      distances.push({ housenumber: housenumber, dist: dist, parity: parity });

    }, this);

    // ensure distances are sorted by distance ascending
    // this is important because now the distances and coordinates
    // arrays will run from the start of the street to the end.
    distances.sort( function( a, b ){
      return ( a.dist > b.dist ) ? 1 : -1;
    });

    /**
      compute the scheme (zig-zag vs. updown) of each road based on
      the house number parity.
      @see: https://en.wikipedia.org/wiki/House_numbering

      zigzag: 1   3   5   7   9
              └─┬─┴─┬─┴─┬─┴─┬─┘
                2   4   5   8

      updown: 1   2   3   4   5
              └─┬─┴─┬─┴─┬─┴─┬─┘
                9   8   7   6
    **/

    // store a memo of where the odd/even values lie
    var ord = {
      R: { odd: 0, even: 0, total: 0 },
      L: { odd: 0, even: 0, total: 0 }
    };

    // iterate distances to enumerate odd/even on L/R
    distances.forEach( function( cur ){

      if( cur.parity && cur.housenumber ){
        var isEven = parseInt( cur.housenumber, 10 ) %2;
        if( isEven ){ ord[cur.parity].even++; }
        else { ord[cur.parity].odd++; }
        ord[cur.parity].total++;
      }
    });

    // zigzag schemes
    var zz1 = ( ord.R.odd === ord.R.total && ord.L.even === ord.L.total ),
        zz2 = ( ord.L.odd === ord.L.total && ord.R.even === ord.R.total );

    // assign correct scheme to street
    street.scheme = ( zz1 || zz2 ) ? 'zigzag' : 'updown';

    // ----

    // distance travelled along the line string
    var vertexDistance = 0;

    // insert each point on linestring in table
    // note: this allows us to ignore the linestring and simply linearly
    // interpolation between matched values at query time.
    street.coordinates.forEach( function( vertex, i ){

      // not a line, just a single point;
      if( 0 === i ){ return; }

      // distance along line to this vertex
      var edge = street.coordinates.slice(i-1, i+1);
      if( edge.length === 2 ){
        vertexDistance += project.lineDistance( edge );
      } else {
        console.error( 'logic error: should never have else!' );
        return;
      }

      // projected fractional housenumber(s)
      // note: there may be one or two values produced, depending on the scheme.
      var housenumbers = [];

      // zigzag interpolation
      // (one vertex interpolation produced)
      if( street.scheme === 'zigzag' ){
        housenumbers.push( interpolate( distances, vertexDistance ) );
      }
      // updown interpolation
      // (two vertex interpolations produced)
      else {
        // left side
        housenumbers.push( interpolate( distances.filter( function( d ){
          return d.parity === 'L';
        }), vertexDistance ) );

        // right side
        housenumbers.push( interpolate( distances.filter( function( d ){
          return d.parity === 'R';
        }), vertexDistance ) );
      }

      // insert point values in db
      housenumbers.forEach( function( num ){
        if( !num ){ return; } // skip null interpolations
        this.push({
          $id: street.id,
          $source: 'VERTEX',
          $housenumber: num.toFixed(3),
          $lon: undefined,
          $lat: undefined,
          $parity: undefined,
          $proj_lon: vertex[0],
          $proj_lat: vertex[1]
        });
      }, this);

    }, this);

    next();
  });
}

module.exports = streamFactory;
